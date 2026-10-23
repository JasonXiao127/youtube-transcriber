FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && chown -R node:node /app
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD sh -c 'wget -qO- http://127.0.0.1:${PORT:-3000}/api/health || exit 1'
CMD ["node", "server.js"]
