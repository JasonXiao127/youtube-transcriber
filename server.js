"use strict";

const path = require("path");
const express = require("express");
const { YoutubeTranscript } = require("youtube-transcript");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

// --- security headers (page embeds youtube.com, fetches same-origin /api) ---
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "frame-src https://www.youtube.com https://www.youtube-nocookie.com; " +
      "img-src 'self' data:; connect-src 'self'; " +
      "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
  );
  next();
});

// --- per-IP rate limit on the YouTube-backed API (each hit costs upstream) ---
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 120;
const rateHits = new Map();
setInterval(() => rateHits.clear(), RATE_WINDOW_MS).unref();
function rateLimit(req, res, next) {
  const path = req.path.toLowerCase();
  if (path === "/health" || path === "/health/") return next(); // monitoring must not eat the budget
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const n = (rateHits.get(ip) || 0) + 1;
  rateHits.set(ip, n);
  if (n > RATE_MAX) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Too many requests. Slow down and retry." });
  }
  next();
}

// Uniform API surface: JSON everywhere under /api (Express's default HTML
// 404/OPTIONS responses would otherwise leak through on unknown paths and
// wrong methods), and no-store on everything. Successful downloads opt back
// out (ETag revalidation) because their bodies are deterministic.
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(404).json({ error: "Not found." });
  next();
});

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const LANG_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

// Strict host validation: the ID must come from a real YouTube host (or be a
// bare ID). Extracted candidates are re-validated against VIDEO_ID_RE, so no
// quote/CRLF/slash content can flow into fetch URLs, filenames or hrefs.
function parseVideoId(input, depth = 0) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (VIDEO_ID_RE.test(raw)) return raw;
  if (depth > 2) return null;
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    const seg = url.pathname.split("/").filter(Boolean)[0] || "";
    return VIDEO_ID_RE.test(seg) ? seg : null;
  }
  if (!YT_HOSTS.has(host)) return null;
  // Param names are case-insensitive; take the first VALID value in order
  // (?v=bad&v=GOOD yields GOOD; an invalid value never poisons later ones).
  for (const [k, val] of url.searchParams) {
    if (k.toLowerCase() === "v" && VIDEO_ID_RE.test(val)) return val;
  }
  const pm = url.pathname.match(/^\/(?:embed|shorts|live|v|e)\/([^/?#]+)/i);
  if (pm && VIDEO_ID_RE.test(pm[1])) return pm[1];
  // attribution links: /attribution_link?u=/watch?v=ID
  let u = null;
  for (const [k, val] of url.searchParams) {
    if (k.toLowerCase() === "u" && val) {
      u = val;
      break;
    }
  }
  if (u) {
    const nested = parseVideoId(u.startsWith("/") ? `https://www.youtube.com${u}` : u, depth + 1);
    if (nested) return nested;
  }
  return null;
}

// youtube-transcript returns offset/duration in ms for srv3 XML and in seconds
// for classic XML, without saying which. InnerTube (primary path) is srv3/ms.
// Detection order: (1) any fractional value proves classic seconds (srv3 uses
// parseInt integers); (2) otherwise pick the unit that puts the median cue
// duration in the plausible 0.2s-120s range; (3) huge offsets (>27h in
// seconds) prove ms; (4) default to seconds.
function looksLikeMs(cues) {
  const sample = cues.slice(0, 20);
  if (sample.length === 0) return false;
  if (sample.some((c) => !Number.isInteger(c.offset) || !Number.isInteger(c.duration)))
    return false;
  const sorted = sample.map((c) => c.duration).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const asSeconds = median >= 0.2 && median <= 120;
  const asMs = median / 1000 >= 0.2 && median / 1000 <= 120;
  if (asMs && !asSeconds) return true;
  if (asSeconds && !asMs) return false;
  if (Math.max(...sample.map((c) => c.offset)) > 100000) return true;
  return false;
}

function normalizeCues(raw) {
  const ms = looksLikeMs(raw);
  return raw
    .map((c) => ({
      start: Math.max(0, ms ? c.offset / 1000 : c.offset),
      duration: ms ? c.duration / 1000 : c.duration,
      text: String(c.text || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.duration) && c.text)
    .sort((a, b) => a.start - b.start);
}

function pad(n, len = 2) {
  return String(n).padStart(len, "0");
}

function formatHMS(seconds, msSeparator) {
  if (!Number.isFinite(seconds)) seconds = 0;
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSeparator}${pad(ms, 3)}`;
}

// [HH:MM:SS] readable, LLM-friendly. Not player-syncable (use SRT/VTT for that).
function toTXT(cues, meta) {
  const lines = [];
  if (meta) {
    lines.push(`# ${meta.title || "YouTube transcript"}`);
    lines.push(`# video: https://www.youtube.com/watch?v=${meta.videoId}`);
    lines.push(`# lang: ${meta.lang}`);
    lines.push(`# fetched: ${meta.fetchedAt || new Date().toISOString()}`);
    lines.push("");
  }
  for (const c of cues) {
    const t = formatHMS(c.start, ".").split(".")[0]; // HH:MM:SS (any hour width)
    lines.push(`[${t}] ${c.text}`);
  }
  return lines.join("\n") + "\n";
}

function cueEnd(c, next) {
  const dur = Math.max(c.duration, 0);
  let end = c.start + (dur > 0 ? dur : 2);
  if (next && Number.isFinite(next.start) && next.start > c.start)
    end = Math.min(end, next.start);
  if (!(end > c.start)) end = c.start + 2;
  return end;
}

function toSRT(cues) {
  return (
    cues
      .map((c, i) => {
        const end = cueEnd(c, cues[i + 1]);
        return `${i + 1}\n${formatHMS(c.start, ",")} --> ${formatHMS(end, ",")}\n${c.text}\n`;
      })
      .join("\n") + "\n"
  );
}

function toVTT(cues) {
  return (
    "WEBVTT\n\n" +
    cues
      .map((c, i) => {
        const end = cueEnd(c, cues[i + 1]);
        return `${formatHMS(c.start, ".")} --> ${formatHMS(end, ".")}\n${escapeVTT(c.text)}\n`;
      })
      .join("\n") +
    "\n"
  );
}

// WebVTT cue payloads must not contain "-->", "&" or "<" (W3C WebVTT 5.1).
// Escaping ">" as well removes any accidental "-->".
function escapeVTT(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const FORMATTERS = { txt: toTXT, srt: toSRT, vtt: toVTT };
const CONTENT_TYPES = {
  txt: "text/plain; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
};

const UPSTREAM_TIMEOUT_MS = 15000;
async function fetchWithTimeout(url, opts) {
  const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  // The library swallows non-OK InnerTube responses and maps timedtext
  // failures to "not available". Surface upstream throttling as its own
  // error so it maps to 429 instead of a misleading 404.
  if (resp.status === 429) {
    const err = new Error("YouTube rate-limited this server IP (timedtext).");
    err.code = "RATE_LIMITED";
    throw err;
  }
  return resp;
}
const FETCH_CONFIG = { fetch: fetchWithTimeout };

function upstreamError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function listTracks(videoId) {
  const resp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
    },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
      videoId,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (resp.status === 429) throw upstreamError("RATE_LIMITED", "YouTube rate-limited this server IP.");
  if (!resp.ok) throw upstreamError("UPSTREAM", `Caption listing failed (upstream ${resp.status}).`);
  let data;
  try {
    data = await resp.json();
  } catch {
    throw upstreamError("UPSTREAM", "Caption listing failed (bad upstream response).");
  }
  const playability = data?.playabilityStatus?.status;
  if (playability === "ERROR" || playability === "LOGIN_REQUIRED" || playability === "UNPLAYABLE")
    throw upstreamError(
      "VIDEO_UNAVAILABLE",
      data?.playabilityStatus?.reason || "This video is unavailable."
    );
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks)) return [];
  return tracks.map((t) => ({
    languageCode: t.languageCode,
    name: t.name?.simpleText || t.name?.runs?.map((r) => r.text).join("") || t.languageCode,
    isAutoGenerated: t.kind === "asr",
  }));
}

function shortEcho(s) {
  s = String(s || "");
  const chars = [...s];
  return chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : s;
}

function logUpstream(where, videoId, err) {
  console.error(
    `[${where}] ${videoId} ${String(err?.message || err).replace(/\s+/g, " ").slice(0, 300)}`
  );
}

function mapTranscriptError(err, videoId, input, lang) {
  const msg = String(err?.message || err);
  if (err?.constructor?.name === "YoutubeTranscriptTooManyRequestError" || err?.code === "RATE_LIMITED")
    return { status: 429, error: "YouTube rate-limited this server IP. Wait a minute and retry." };
  if (msg.includes("No transcripts are available in")) {
    // Reword the library message (which reads "in <lang> this video") and
    // keep its available-languages list when present and non-empty.
    const avail = msg.match(/Available languages:\s*(.*?)\s*$/);
    return {
      status: 404,
      error:
        `No transcripts are available in "${lang || "?"}" for this video (${videoId}).` +
        (avail && avail[1] ? ` Available languages: ${avail[1]}` : ""),
    };
  }
  if (msg.includes("disabled") || err?.code === "VIDEO_UNAVAILABLE")
    return {
      status: 404,
      error: `No captions are available for this video (${videoId}). The video may have captions disabled, or be private or deleted.`,
    };
  if (msg.includes("No transcripts are available"))
    return { status: 404, error: `No captions found for this video (${videoId}).` };
  if (msg.includes("no longer available"))
    return {
      status: 404,
      error: `This video is unavailable (${videoId}). It may be private, deleted, or removed.`,
    };
  if (msg.includes("Impossible to retrieve"))
    return { status: 400, error: `Could not find a YouTube video ID in "${shortEcho(input)}".` };
  if (msg.includes("Empty transcript"))
    return { status: 404, error: "YouTube returned an empty transcript for this video." };
  logUpstream("transcript", videoId, err);
  return { status: 502, error: "Failed to fetch the transcript (upstream error)." };
}

function mapListError(err, videoId) {
  if (err?.code === "RATE_LIMITED")
    return { status: 429, error: "YouTube rate-limited this server IP. Wait a minute and retry." };
  if (err?.code === "VIDEO_UNAVAILABLE")
    return {
      status: 404,
      error: `This video is unavailable (${videoId}). It may be private, deleted, or removed.`,
    };
  logUpstream("tracks", videoId, err);
  return { status: 502, error: "Failed to list caption tracks (upstream error)." };
}

// Short-lived in-memory cache: transcripts don't change, and every download
// format reuses the same cues. Caps memory; keyed by video+lang.
const transcriptCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

async function getTranscript(videoId, lang) {
  const key = `${videoId}|${lang || ""}`;
  const hit = transcriptCache.get(key);
  if (hit) {
    if (hit.expires > Date.now()) return { cues: hit.cues, lang: hit.lang, fetchedAt: hit.fetchedAt };
    transcriptCache.delete(key); // don't let expired entries linger
  }
  // Fail fast when YouTube is throttling this server: one cheap call instead
  // of a full fetch chain per request during a storm. Anything else is
  // ignored here — the library's HTML fallback below may still succeed
  // (e.g. age-restricted or edge cases where InnerTube reports unavailable).
  try {
    await listTracks(videoId);
  } catch (e) {
    if (e.code === "RATE_LIMITED") throw e;
  }
  const raw = await YoutubeTranscript.fetchTranscript(
    videoId,
    lang ? { lang, ...FETCH_CONFIG } : FETCH_CONFIG
  );
  const cues = normalizeCues(raw);
  if (cues.length === 0) throw new Error("Empty transcript received from YouTube.");
  const resolvedLang = raw[0]?.lang || lang || "en";
  const fetchedAt = new Date().toISOString();
  const value = { cues, lang: resolvedLang, fetchedAt, expires: Date.now() + CACHE_TTL_MS };
  const put = (k) => {
    if (transcriptCache.size >= CACHE_MAX) {
      // Prefer evicting an already-expired entry over the oldest one.
      const now = Date.now();
      let evict = transcriptCache.keys().next().value;
      for (const [ek, ev] of transcriptCache) {
        if (ev.expires <= now) {
          evict = ek;
          break;
        }
      }
      transcriptCache.delete(evict);
    }
    transcriptCache.set(k, value);
  };
  put(key);
  // Auto mode resolves to a concrete track: alias that key to the same entry
  // so the first explicit-lang request (e.g. the UI's download right after
  // an auto preview) is a cache hit instead of a refetch.
  const alias = `${videoId}|${resolvedLang}`;
  if (!lang && alias !== key && !transcriptCache.has(alias)) put(alias);
  return { cues, lang: resolvedLang, fetchedAt };
}

function validLang(raw) {
  const lang = String(raw || "").trim();
  if (!lang) return undefined;
  return LANG_RE.test(lang) ? lang : null; // null = malformed
}

// Upstream track data is not trusted for headers: fall back to the
// requested lang (or en) when it doesn't match the allowlist.
function sanitizeLang(resolved, fallback) {
  return typeof resolved === "string" && LANG_RE.test(resolved) ? resolved : fallback || "en";
}

app.use(express.static(path.join(__dirname, "public")));
app.use("/api", rateLimit);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/tracks", async (req, res) => {
  const videoId = parseVideoId(req.query.input || req.query.videoId);
  if (!videoId) return res.status(400).json({ error: "Provide ?input=<youtube url or 11-char id>." });
  try {
    const tracks = await listTracks(videoId);
    res.json({ videoId, tracks });
  } catch (e) {
    const { status, error } = mapListError(e, videoId);
    if (status === 429) res.setHeader("Retry-After", "60");
    res.status(status).json({ error });
  }
});

app.get("/api/transcript", async (req, res) => {
  const input = String(req.query.input || req.query.videoId || "");
  const videoId = parseVideoId(input);
  if (!videoId)
    return res.status(400).json({ error: `Could not find a YouTube video ID in "${shortEcho(input)}".` });
  const lang = validLang(req.query.lang);
  if (lang === null) return res.status(400).json({ error: "Invalid lang code." });
  try {
    const { cues, lang: resolved, fetchedAt } = await getTranscript(videoId, lang);
    res.json({ videoId, lang: resolved, count: cues.length, fetchedAt, cues });
  } catch (e) {
    const { status, error } = mapTranscriptError(e, videoId, input, lang);
    if (status === 429) res.setHeader("Retry-After", "60");
    res.status(status).json({ error });
  }
});

app.get("/api/download", async (req, res) => {
  const input = String(req.query.input || req.query.videoId || "");
  const format = String(req.query.format || "txt").toLowerCase();
  if (!Object.hasOwn(FORMATTERS, format) || !Object.hasOwn(CONTENT_TYPES, format))
    return res.status(400).json({ error: "format must be txt, srt or vtt." });
  const videoId = parseVideoId(input);
  if (!videoId)
    return res.status(400).json({ error: `Could not find a YouTube video ID in "${shortEcho(input)}".` });
  const lang = validLang(req.query.lang);
  if (lang === null) return res.status(400).json({ error: "Invalid lang code." });
  try {
    const { cues, lang: resolved, fetchedAt } = await getTranscript(videoId, lang);
    // resolved comes from upstream track data: re-validate before headers.
    const safeLang = sanitizeLang(resolved, lang);
    const body = FORMATTERS[format](cues, { videoId, lang: safeLang, fetchedAt });
    // Content-Disposition first: if it ever throws, Content-Type is still
    // unset and the error path below returns clean JSON.
    res.setHeader("Content-Disposition", `attachment; filename="${videoId}_${safeLang}.${format}"`);
    res.setHeader("Content-Type", CONTENT_TYPES[format]);
    res.removeHeader("Cache-Control"); // deterministic body: allow ETag/304
    res.send(body);
  } catch (e) {
    const { status, error } = mapTranscriptError(e, videoId, input, lang);
    if (status === 429) res.setHeader("Retry-After", "60");
    res.status(status).json({ error });
  }
});

// Anything under /api that reaches here matched no route (unknown path or
// wrong method, including OPTIONS): answer JSON, not Express's HTML 404.
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

let server = null;
if (require.main === module) {
  server = app.listen(PORT, () => console.log(`youtube-transcriber on http://localhost:${PORT}`));
  const shutdown = (sig) => {
    console.log(`${sig} received, draining…`);
    // Drop idle keep-alive sockets so close() doesn't wait on them.
    try {
      server.closeIdleConnections();
    } catch {}
    server.close(() => process.exit(0));
    // Longer than the 15s upstream timeout so in-flight fetches can finish.
    setTimeout(() => process.exit(1), 20000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = {
  app,
  parseVideoId,
  looksLikeMs,
  normalizeCues,
  formatHMS,
  fetchWithTimeout,
  escapeVTT,
  FORMATTERS,
  sanitizeLang,
  toTXT,
  toSRT,
  toVTT,
  validLang,
  listTracks,
  getTranscript,
  mapTranscriptError,
  mapListError,
};
