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

# gosu: the entrypoint runs as root only long enough to fix /data ownership on a bind mount,
# then steps down to the unprivileged `node` user to run the server.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && gosu nobody true

# Only the server's production deps (sharp ships prebuilt linux binaries; node:sqlite is built in).
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-build /build/server/dist ./dist
COPY --from=client-build /build/client/dist ./client-dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# All mutable state (SQLite catalog, config.json, per-file asset cache) lives under /data,
# which should be a mounted volume. Watched model folders get mounted under /models (read-only).
# (Upgrading from a build that had THUMBNAILS_DIR=/data/thumbnails? Set that env var once more
# on the new image so db.ts migrates the old thumbnails into /data/assets, then drop it.)
# HOST=0.0.0.0 so the published port works; the container is only as exposed as the
# `ports:` mapping in docker-compose.yml makes it (loopback-only by default there).
ENV PORT=3001 \
    HOST=0.0.0.0 \
    CLIENT_DIST=/app/client-dist \
    DB_PATH=/data/catalog.db \
    CONFIG_PATH=/data/config.json \
    ASSETS_DIR=/data/assets \
    PRINTSORT_MODELS_DIR=/models \
    SCAN_ON_STARTUP=true

RUN mkdir -p /data /models && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 3001

# Starts as root; docker-entrypoint.sh chowns /data then drops to `node` via gosu.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
