"use strict";
// Offline smoke tests: no YouTube network access needed.
// Run: npm test
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  app,
  parseVideoId,
  looksLikeMs,
  normalizeCues,
  formatHMS,
  toTXT,
  toSRT,
  toVTT,
} = require("../server.js");

const ID = "dQw4w9WgXcQ";

test("parseVideoId accepts real YouTube forms", () => {
  const cases = [
    [ID, ID],
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}?t=30`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`https://www.youtube.com/embed/${ID}`, ID],
    [`https://www.youtube.com/live/${ID}`, ID],
    [`https://music.youtube.com/watch?v=${ID}&list=x`, ID],
    [`https://m.youtube.com/watch?v=${ID}`, ID],
    [`https://www.youtube-nocookie.com/embed/${ID}`, ID],
    [`HTTPS://YOUTUBE.COM/watch?v=${ID}`, ID],
    [`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`, ID],
    [`https://www.youtube.com/watch?v=${ID}&v=BBBBBBBBBBB`, ID], // first v wins
    [`HTTPS://WWW.YOUTUBE.COM/WATCH?V=${ID}`, ID], // uppercase param name
    [`https://www.youtube.com/attribution_link?u=/watch?v=${ID}`, ID],
    [`https://www.youtube.com/v/${ID}`, ID],
    [`https://www.youtube.com/e/${ID}`, ID],
    [`https://www.youtube.com/watch?v=short&v=${ID}`, ID], // first valid v wins
    [`https://www.youtube.com/watch?V=short&v=${ID}`, ID], // case-insensitive, skips invalid
    [`https://www.youtube.com/attribution_link?U=/watch?v=${ID}`, ID],
    [`youtu.be/${ID}/extra/more`, ID],
    [`  ${ID}  \n`, ID],
  ];
  for (const [input, want] of cases) assert.equal(parseVideoId(input), want, input);
});

test("parseVideoId rejects hostile and malformed input", () => {
  const cases = [
    "",
    "garbage",
    `https://fakeyoutube.com/watch?v=${ID}`,
    `https://notyoutube.com/embed/${ID}`,
    `https://myyoutu.be/${ID}`,
    `https://evil.com/?x=youtube.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`,
    `https://youtu.be/${ID}0`, // no silent truncation
    `https://www.youtube.com/watch?v=${ID}0`,
    `https://www.youtube.com/watch#v=${ID}`,
    `https://youtu.be/${ID.slice(0, 10)}!`,
  ];
  for (const input of cases) assert.equal(parseVideoId(input), null, input);
});

test("looksLikeMs disambiguates units", () => {
  assert.equal(looksLikeMs([{ offset: 1360, duration: 1680, text: "x" }]), true); // srv3 ms
  assert.equal(looksLikeMs([{ offset: 1.36, duration: 1.68, text: "x" }]), false); // classic s
  assert.equal(
    looksLikeMs([
      { offset: 0, duration: 45, text: "a" },
      { offset: 45, duration: 40, text: "b" },
    ]),
    false
  ); // long classic cues stay seconds
  assert.equal(looksLikeMs([{ offset: 1360.5, duration: 1680.5, text: "x" }]), false); // fractional proves seconds
  assert.equal(looksLikeMs([{ offset: 200000, duration: 0, text: "x" }]), true); // huge offsets prove ms
  assert.equal(looksLikeMs([{ offset: 10, duration: 0, text: "x" }]), false);
  assert.equal(looksLikeMs([]), false);
});

test("normalizeCues converts, filters and sorts", () => {
  assert.deepEqual(normalizeCues([{ offset: 1360, duration: 1680, text: " hi " }]), [
    { start: 1.36, duration: 1.68, text: "hi" },
  ]);
  assert.deepEqual(normalizeCues([{ offset: 7200000, duration: 2000, text: "x" }]), [
    { start: 7200, duration: 2, text: "x" },
  ]);
  assert.deepEqual(normalizeCues([{ offset: 7200.5, duration: 2.25, text: "x" }]), [
    { start: 7200.5, duration: 2.25, text: "x" },
  ]);
  assert.deepEqual(normalizeCues([{ offset: NaN, duration: 1, text: "a" }]), []);
  assert.deepEqual(normalizeCues([{ offset: 2, duration: 1, text: "  " }]), []);
  const sorted = normalizeCues([
    { offset: 12, duration: 4, text: "b" },
    { offset: 10, duration: 5, text: "a" },
  ]);
  assert.equal(sorted[0].text, "a");
  assert.ok(normalizeCues([{ offset: -3, duration: 1, text: "a" }])[0].start >= 0);
});

test("formatHMS handles edges", () => {
  assert.ok(formatHMS(NaN, ",").startsWith("00:00:00"));
  assert.ok(formatHMS(59.9995, ",").startsWith("00:01:00"));
  assert.equal(formatHMS(360000, ".").split(".")[0], "100:00:00");
});

test("toTXT header and timestamps", () => {
  const out = toTXT([{ start: 3661.5, duration: 2, text: "hi" }], {
    videoId: ID,
    lang: "en",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(out.includes("# video: https://www.youtube.com/watch?v=" + ID));
  assert.ok(out.includes("# fetched: 2026-01-01T00:00:00.000Z"));
  assert.ok(out.includes("[01:01:01] hi"));
  const far = toTXT([{ start: 360000, duration: 2, text: "x" }], { videoId: ID, lang: "en" });
  assert.ok(far.includes("[100:00:00]"));
});

test("toSRT never emits zero-length or inverted cues", () => {
  const srt = toSRT([
    { start: 10, duration: 0, text: "a" },
    { start: 15, duration: 2, text: "b" },
  ]);
  for (const block of srt.trim().split("\n\n")) {
    const [start, end] = block.split("\n")[1].split(" --> ");
    assert.ok(end > start, block);
  }
  assert.ok(!toSRT([{ start: 5, duration: 1, text: "a" }]).includes("NaN"));
  assert.equal(
    toSRT([
      { start: 10, duration: 100, text: "overlap" },
      { start: 12, duration: 2, text: "next" },
    ]),
    "1\n00:00:10,000 --> 00:00:12,000\noverlap\n\n2\n00:00:12,000 --> 00:00:14,000\nnext\n\n"
  );
});

test("toVTT escapes payloads per spec", () => {
  const vtt = toVTT([{ start: 1, duration: 2, text: "a --> b & <c>" }]);
  assert.ok(vtt.startsWith("WEBVTT"));
  const payload = vtt.trim().split("\n").slice(-1)[0]; // cue text line only
  assert.ok(!payload.includes("-->"), payload);
  assert.ok(payload.includes("&amp;"));
  assert.ok(payload.includes("&lt;c&gt;"));
  const { escapeVTT } = require("../server.js");
  assert.equal(escapeVTT("a --> b & <c>"), "a --&gt; b &amp; &lt;c&gt;");
  assert.equal(escapeVTT("plain"), "plain");
});

// --- HTTP-level (ephemeral port, no upstream calls: all inputs fail before fetch) ---
let base;
let server;
test("http setup", async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test("health is 200 with security headers", async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-powered-by"), null);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.ok((r.headers.get("content-security-policy") || "").includes("frame-src"));
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { ok: true });
  // Case-insensitive routes stay exempt too.
  assert.equal((await fetch(`${base}/API/HEALTH`)).status, 200);
  assert.equal((await fetch(`${base}/api/health/`)).status, 200);
});

test("bad inputs are 400 JSON without upstream calls", async () => {
  for (const url of [
    `${base}/api/transcript?input=garbage`,
    `${base}/api/transcript?input=${ID}&lang=en%0D%0Aevil`,
    `${base}/api/transcript?input=${ID}&lang=en&lang=fr`,
    `${base}/api/download?input=${ID}&format=pdf`,
    `${base}/api/download?input=${ID}&format=constructor`, // prototype key
    `${base}/api/download?input=${ID}&format=__proto__`, // prototype key
    `${base}/api/download?input=${ID}&format=srt%20`,
  ]) {
    const r = await fetch(url);
    assert.equal(r.status, 400, url);
    assert.ok((await r.json()).error, url);
  }
});

// Helper: stub the InnerTube call so getTranscript's preflight passes
// without network; the test's own HTTP calls still go through.
async function withUpstreamTracks(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("youtubei")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          playabilityStatus: { status: "OK" },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
        }),
      };
    }
    return realFetch(url, opts);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("unknown path is a clean 404", async () => {
  const r = await fetch(`${base}/nope-xyz`);
  assert.equal(r.status, 404);
});

test("CLI arg parsing", () => {
  const { parseArgs, formatHelp } = require("../bin/yt-transcript.js");
  assert.deepEqual(parseArgs(["dQw4w9WgXcQ"]), {
    input: "dQw4w9WgXcQ",
    format: "txt",
    lang: undefined,
    output: null,
    listLangs: false,
    help: false,
  });
  assert.equal(parseArgs(["dQw4w9WgXcQ", "-f", "srt", "-l", "en", "-o", "o.srt"]).format, "srt");
  assert.equal(parseArgs(["dQw4w9WgXcQ", "--format=vtt", "--lang=es", "--output=x"]).lang, "es");
  assert.equal(parseArgs(["--list-langs", "dQw4w9WgXcQ"]).listLangs, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.throws(() => parseArgs(["a", "b"]), /single/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
  assert.throws(() => parseArgs(["-f"]), /Missing value/);
  assert.ok(formatHelp().includes("yt-transcript <youtube-url-or-id>"));
  assert.throws(() => parseArgs(["--format=", "dQw4w9WgXcQ"]), /Missing value/);
  assert.throws(() => parseArgs(["--lang=", "dQw4w9WgXcQ"]), /Missing value/);
  assert.throws(() => parseArgs(["--output=", "dQw4w9WgXcQ"]), /Missing value/);
  assert.deepEqual(parseArgs(["--", "-f"]).input, "-f");
  assert.throws(() => parseArgs(["--", "--format", "x"]), /single/); // -- passes through, still one positional max
});

test("sanitizeLang falls back on upstream-shaped values", () => {
  const { sanitizeLang } = require("../server.js");
  assert.equal(sanitizeLang("en", undefined), "en");
  assert.equal(sanitizeLang("de-DE", undefined), "de-DE");
  assert.equal(sanitizeLang("es\r\nX: 1", "fr"), "fr");
  assert.equal(sanitizeLang("es\r\nX: 1", undefined), "en");
  assert.equal(sanitizeLang(undefined, undefined), "en");
});

test("long error input keeps astral characters intact", async () => {
  const input = "A".repeat(119) + "😀" + "B".repeat(10);
  const r = await fetch(`${base}/api/transcript?input=${encodeURIComponent(input)}`);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /😀/);
});

test("CLI usage errors exit 2 without network (stubbed io)", async () => {
  const { run } = require("../bin/yt-transcript.js");
  const sink = () => {
    let text = "";
    return { write: (s) => { text += s; }, get: () => text };
  };
  for (const argv of [[], ["--"], ["garbage"], ["dQw4w9WgXcQ", "--format", "pdf"], ["dQw4w9WgXcQ", "-l", "en!!"], ["dQw4w9WgXcQ", "--format="], ["dQw4w9WgXcQ", "--format", ""], ["dQw4w9WgXcQ", "-o", ""]]) {
    const stdout = sink();
    const stderr = sink();
    assert.equal(await run(argv, { stdout, stderr }), 2);
    assert.ok(stderr.get().startsWith("Error:"), argv.join(" "));
  }
  const helpOut = sink();
  assert.equal(await run(["--help"], { stdout: helpOut, stderr: sink() }), 0);
  assert.ok(helpOut.get().includes("Usage:"));
});

test("CLI exit-1 paths: fetch, list and write failures (stubbed)", async () => {
  const { run } = require("../bin/yt-transcript.js");
  const YT = require("youtube-transcript");
  const origLib = YT.YoutubeTranscript.fetchTranscript;
  const origFetch = globalThis.fetch;
  const sink = () => {
    let text = "";
    return { write: (s) => { text += s; }, get: () => text };
  };
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("youtubei")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ playabilityStatus: { status: "OK" }, captions: {} }),
      };
    }
    return origFetch(url, opts);
  };
  try {
    YT.YoutubeTranscript.fetchTranscript = async () => {
      throw new Error("boom");
    };
    const stderr = sink();
    assert.equal(await run(["HHHHHHHHHHH"], { stdout: sink(), stderr }), 1);
    assert.match(stderr.get(), /Failed to fetch the transcript/);
    const listErr = sink();
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("youtubei")) return { ok: false, status: 500, json: async () => ({}) };
      return origFetch(url, opts);
    };
    assert.equal(await run(["HHHHHHHHHHH", "--list-langs"], { stdout: sink(), stderr: listErr }), 1);
    assert.match(listErr.get(), /Failed to list caption tracks/);
    YT.YoutubeTranscript.fetchTranscript = async () => [
      { offset: 1000, duration: 2000, text: "hi", lang: "en" },
    ];
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("youtubei")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ playabilityStatus: { status: "OK" }, captions: {} }),
        };
      }
      return origFetch(url, opts);
    };
    const writeErr = sink();
    const code = await run(["HHHHHHHHHHH", "-o", "/no/such/dir/f.txt"], {
      stdout: sink(),
      stderr: writeErr,
      writeFile: () => {
        throw new Error("EROFS: read-only");
      },
    });
    assert.equal(code, 1);
    assert.match(writeErr.get(), /cannot write to/);
  } finally {
    YT.YoutubeTranscript.fetchTranscript = origLib;
    globalThis.fetch = origFetch;
  }
});

test("CLI write failures exit 1 without throwing (stubbed io)", async () => {
  const { run } = require("../bin/yt-transcript.js");
  const sink = () => {
    let text = "";
    return { write: (s) => { text += s; }, get: () => text };
  };
  const throwing = () => ({
    write: () => {
      throw new Error("EPIPE: closed pipe");
    },
  });
  const err1 = sink();
  assert.equal(await run(["--help"], { stdout: throwing(), stderr: err1 }), 1);
  assert.match(err1.get(), /failed to write output/);
  const YT = require("youtube-transcript");
  const origLib = YT.YoutubeTranscript.fetchTranscript;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("youtubei")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ playabilityStatus: { status: "OK" }, captions: {} }),
      };
    }
    return origFetch(url, opts);
  };
  YT.YoutubeTranscript.fetchTranscript = async () => [
    { offset: 1000, duration: 2000, text: "hi", lang: "en" },
  ];
  try {
    const err2 = sink();
    assert.equal(
      await run(["HHHHHHHHHHH", "--list-langs"], { stdout: throwing(), stderr: err2 }),
      1
    );
    assert.match(err2.get(), /failed to write output/);
    assert.ok(!err2.get().includes("upstream"), err2.get());
  } finally {
    YT.YoutubeTranscript.fetchTranscript = origLib;
    globalThis.fetch = origFetch;
  }
});

test("CLI success paths with stubbed fetch (no network)", async () => {
  const { run } = require("../bin/yt-transcript.js");
  const YT = require("youtube-transcript");
  const origLib = YT.YoutubeTranscript.fetchTranscript;
  const origFetch = globalThis.fetch;
  const sink = () => {
    let text = "";
    return { write: (s) => { text += s; }, get: () => text };
  };
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("youtubei")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          playabilityStatus: { status: "OK" },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
        }),
      };
    }
    return origFetch(url, opts);
  };
  YT.YoutubeTranscript.fetchTranscript = async () => [
    { offset: 1000, duration: 2000, text: "hi", lang: "en" },
  ];
  try {
    const stdout = sink();
    assert.equal(await run(["GGGGGGGGGGG"], { stdout, stderr: sink() }), 0);
    assert.match(stdout.get(), /\[00:00:01\] hi/);
    let saved = null;
    const code = await run(["GGGGGGGGGGG", "-f", "srt", "-o", "out.srt"], {
      stdout: sink(),
      stderr: sink(),
      writeFile: (p, body) => { saved = { p, body }; },
    });
    assert.equal(code, 0);
    assert.equal(saved.p, "out.srt");
    assert.match(saved.body, /00:00:01,000 --> 00:00:03,000/);
    const langs = sink();
    assert.equal(await run(["GGGGGGGGGGG", "--list-langs"], { stdout: langs, stderr: sink() }), 0);
    assert.match(langs.get(), /No caption tracks found/);
  } finally {
    YT.YoutubeTranscript.fetchTranscript = origLib;
    globalThis.fetch = origFetch;
  }
});

test("wrong method and OPTIONS under /api are JSON 404", async () => {
  for (const [method, url] of [
    ["POST", `${base}/api/transcript?input=garbage`],
    ["DELETE", `${base}/api/tracks?input=garbage`],
    ["OPTIONS", `${base}/api/transcript?input=garbage`],
  ]) {
    const r = await fetch(url, { method });
    assert.equal(r.status, 404, method);
    assert.match((await r.json()).error, /not found/i);
  }
});

test("/api/health/ with trailing slash is exempt", async () => {
  const r = await fetch(`${base}/api/health/`);
  assert.equal(r.status, 200);
});

test("listTracks maps UNPLAYABLE to 404 unavailable (stubbed upstream)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes("youtubei")) return realFetch(url, opts);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        playabilityStatus: { status: "UNPLAYABLE", reason: "Blocked" },
        captions: {},
      }),
    };
  };
  try {
    const r = await fetch(`${base}/api/tracks?input=AAAAAAAAAAA`);
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /unavailable/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("transcript error map: statuses without network (stubbed library)", async () => {
  const YT = require("youtube-transcript");
  const orig = YT.YoutubeTranscript.fetchTranscript;
  const cases = [
    [new Error("No transcripts are available in xx this video (x)."), 404],
    [new Error("No transcripts are available for this video (x)."), 404, /No captions found/],
    [new Error("[YoutubeTranscript] 🚨 Transcript is disabled on this video (x)"), 404, /disabled/],
    [
      new Error("[YoutubeTranscript] 🚨 The video is no longer available (x)"),
      404,
      /unavailable/i,
    ],
    [Object.assign(new Error("Transcript is disabled"), { code: "VIDEO_UNAVAILABLE" }), 404],
    [new Error("Empty transcript received from YouTube."), 404],
    [Object.assign(new Error("YouTube rate-limited"), { code: "RATE_LIMITED" }), 429],
    [new Error("boom"), 502],
  ];
  try {
    await withUpstreamTracks(async () => {
      for (const [err, status, match] of cases) {
        YT.YoutubeTranscript.fetchTranscript = async () => {
          throw err;
        };
        const r = await fetch(`${base}/api/transcript?input=BBBBBBBBBBB&lang=en`);
        assert.equal(r.status, status, err.message);
        const body = await r.json();
        assert.ok(body.error);
        if (match) assert.match(body.error, match);
      }
      // Grammar: library phrasing is reworded, language list kept.
      YT.YoutubeTranscript.fetchTranscript = async () => {
        throw new Error("No transcripts are available in xx this video (x). Available languages: en, es");
      };
      const g = await (await fetch(`${base}/api/transcript?input=BBBBBBBBBBB&lang=xx`)).json();
      assert.match(g.error, /in "xx" for this video/);
      assert.match(g.error, /Available languages: en, es/);
      // Message without a language list: no dangling suffix.
      YT.YoutubeTranscript.fetchTranscript = async () => {
        throw new Error("No transcripts are available in xx this video (x).");
      };
      const h = await (await fetch(`${base}/api/transcript?input=BBBBBBBBBBB&lang=xx`)).json();
      assert.match(h.error, /in "xx" for this video \(BBBBBBBBBBB\)\./);
      assert.ok(!h.error.includes("Available languages"), h.error);
    });
  } finally {
    YT.YoutubeTranscript.fetchTranscript = orig;
  }
});

test("fetchedAt is stable across cached reads (stubbed library)", async () => {
  const YT = require("youtube-transcript");
  const orig = YT.YoutubeTranscript.fetchTranscript;
  let calls = 0;
  YT.YoutubeTranscript.fetchTranscript = async () => {
    calls++;
    return [{ offset: 1360, duration: 1680, text: "hi", lang: "en" }];
  };
  try {
    await withUpstreamTracks(async () => {
      const a = await (await fetch(`${base}/api/transcript?input=CCCCCCCCCCC&lang=en`)).json();
      const b = await (await fetch(`${base}/api/transcript?input=CCCCCCCCCCC&lang=en`)).json();
      assert.equal(calls, 1);
      assert.equal(a.fetchedAt, b.fetchedAt);
      assert.equal(a.cues[0].start, 1.36);
    });
  } finally {
    YT.YoutubeTranscript.fetchTranscript = orig;
  }
});

test("listTracks maps upstream failures (stubbed)", async () => {
  const realFetch = globalThis.fetch;
  const bodies = {
    err429: { status: 429, ok: false, json: async () => ({}) },
    err500: { status: 500, ok: false, json: async () => ({}) },
    badjson: {
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError("bad");
      },
    },
    login: {
      status: 200,
      ok: true,
      json: async () => ({ playabilityStatus: { status: "LOGIN_REQUIRED" } }),
    },
  };
  try {
    for (const [key, fake] of Object.entries(bodies)) {
      globalThis.fetch = async (url, opts) =>
        String(url).includes("youtubei") ? fake : realFetch(url, opts);
      const r = await fetch(`${base}/api/tracks?input=DDDDDDDDDDD`);
      const want = key === "err429" ? 429 : key === "login" ? 404 : 502;
      assert.equal(r.status, want, key);
      assert.ok((await r.json()).error, key);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("download success path: names, types, bodies (stubbed library)", async () => {
  const YT = require("youtube-transcript");
  const orig = YT.YoutubeTranscript.fetchTranscript;
  YT.YoutubeTranscript.fetchTranscript = async () => [
    { offset: 1000, duration: 2000, text: "a --> b & <c>", lang: "en" },
  ];
  try {
    await withUpstreamTracks(async () => {
      const txt = await fetch(`${base}/api/download?input=EEEEEEEEEEE&format=TXT`);
      assert.equal(txt.status, 200);
      assert.equal(txt.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.match(
        txt.headers.get("content-disposition") || "",
        /attachment; filename="EEEEEEEEEEE_en\.txt"/
      );
      const txtBody = await txt.text();
      assert.match(txtBody, /# video: https:\/\/www\.youtube\.com\/watch\?v=EEEEEEEEEEE/);
      assert.match(txtBody, /\[00:00:01\] a --> b & <c>/); // TXT keeps raw text
      const srt = await fetch(`${base}/api/download?input=EEEEEEEEEEE&format=srt`);
      assert.equal(srt.headers.get("content-type"), "application/x-subrip; charset=utf-8");
      const vtt = await fetch(`${base}/api/download?input=EEEEEEEEEEE&format=vtt`);
      assert.equal(vtt.headers.get("content-type"), "text/vtt; charset=utf-8");
      const vttBody = await vtt.text();
      assert.ok(vttBody.startsWith("WEBVTT"));
      assert.ok(!vttBody.split("\n").slice(-2)[0].includes("-->"));
      // Error bodies on /api/download carry no-store.
      const bad = await fetch(`${base}/api/download?input=EEEEEEEEEEE&format=zzz`);
      assert.equal(bad.status, 400);
      assert.equal(bad.headers.get("cache-control"), "no-store");
    });
  } finally {
    YT.YoutubeTranscript.fetchTranscript = orig;
  }
});
test("transcript preflight fails fast only on throttle (stubbed)", async () => {
  const realFetch = globalThis.fetch;
  const YT = require("youtube-transcript");
  const origLib = YT.YoutubeTranscript.fetchTranscript;
  let libCalls = 0;
  YT.YoutubeTranscript.fetchTranscript = async () => {
    libCalls++;
    return [{ offset: 1000, duration: 2000, text: "hi", lang: "en" }];
  };
  const stubInnerTube = (status) => {
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("youtubei")) {
        return {
          ok: status === "OK",
          status: status === "OK" ? 200 : status === "LIMITED" ? 429 : 500,
          json: async () => ({ playabilityStatus: { status, reason: "Gone" } }),
        };
      }
      return realFetch(url, opts);
    };
  };
  try {
    // Throttled: 429 without ever calling the library.
    stubInnerTube("LIMITED");
    const t = await fetch(`${base}/api/transcript?input=FFFFFFFFFFF&lang=en`);
    assert.equal(t.status, 429);
    assert.equal(t.headers.get("retry-after"), "60");
    assert.equal(libCalls, 0);
    // Unavailable: preflight does NOT preempt the library fallback.
    stubInnerTube("ERROR");
    const u = await fetch(`${base}/api/transcript?input=FFFFFFFFFFF&lang=en`);
    assert.equal(u.status, 200);
    assert.equal(libCalls, 1);
  } finally {
    globalThis.fetch = realFetch;
    YT.YoutubeTranscript.fetchTranscript = origLib;
  }
});
test("auto fetch populates the explicit-lang cache alias (stubbed)", async () => {
  const YT = require("youtube-transcript");
  const orig = YT.YoutubeTranscript.fetchTranscript;
  let calls = 0;
  YT.YoutubeTranscript.fetchTranscript = async () => {
    calls++;
    return [{ offset: 1360, duration: 1680, text: "hi", lang: "en" }];
  };
  try {
    await withUpstreamTracks(async () => {
      const a = await (await fetch(`${base}/api/transcript?input=IIIIIIIIIII`)).json();
      assert.equal(a.lang, "en");
      const b = await (await fetch(`${base}/api/transcript?input=IIIIIIIIIII&lang=en`)).json();
      assert.equal(calls, 1);
      assert.equal(a.fetchedAt, b.fetchedAt);
      assert.deepEqual(a.cues, b.cues);
    });
  } finally {
    YT.YoutubeTranscript.fetchTranscript = orig;
  }
});
test("fetchWithTimeout converts HTTP 429 to coded error", async () => {
  const http = require("node:http");
  const { fetchWithTimeout } = require("../server.js");
  const srv = http.createServer((req, res) => {
    res.writeHead(req.url === "/limited" ? 429 : 200);
    res.end("x");
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    const ok = await fetchWithTimeout(`http://127.0.0.1:${srv.address().port}/ok`, {});
    assert.equal(ok.status, 200);
    await assert.rejects(fetchWithTimeout(`http://127.0.0.1:${srv.address().port}/limited`, {}), (e) => {
      assert.equal(e.code, "RATE_LIMITED");
      return true;
    });
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("rate limiter engages (last)", async () => {
  let limited = 0;
  let retryAfter = null;
  for (let i = 0; i < 130; i++) {
    const r = await fetch(`${base}/api/transcript?input=garbage`);
    if (r.status === 429) {
      limited++;
      retryAfter = r.headers.get("retry-after");
    }
    await r.arrayBuffer(); // drain
  }
  assert.ok(limited >= 5, `expected 429s, got ${limited}`);
  assert.equal(retryAfter, "60");
  // /api/health is exempt from the budget even after exhaustion.
  const h = await fetch(`${base}/api/health`);
  assert.equal(h.status, 200);
  await h.arrayBuffer();
});
