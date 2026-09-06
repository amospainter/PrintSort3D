# syntax=docker/dockerfile:1

# ---- Build the client (Vite static bundle) ----
FROM node:22-bookworm-slim AS client-build
WORKDIR /build/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Build the server (tsc -> dist/) ----
FROM node:22-bookworm-slim AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- Runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Only the server's production deps (sharp ships prebuilt linux binaries; node:sqlite is built in).
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-build /build/server/dist ./dist
COPY --from=client-build /build/client/dist ./client-dist

# All mutable state (SQLite catalog, config.json, thumbnail + asset caches) lives under /data,
# which should be a mounted volume. Watched model folders get mounted under /models (read-only).
ENV PORT=3001 \
    CLIENT_DIST=/app/client-dist \
    DB_PATH=/data/catalog.db \
    CONFIG_PATH=/data/config.json \
    THUMBNAILS_DIR=/data/thumbnails \
    ASSETS_DIR=/data/assets \
    PRINTSORT_MODELS_DIR=/models \
    SCAN_ON_STARTUP=true

RUN mkdir -p /data /models && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3001

CMD ["node", "dist/index.js"]
