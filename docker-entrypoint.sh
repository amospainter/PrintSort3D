#!/bin/sh
set -e

# /data is almost always a mounted volume or bind mount, and its ownership on the host
# rarely matches the container's unprivileged `node` user (UID 1000). Fix it here, while
# we're still root, then drop privileges to `node` for the actual process.
#
# Set PRINTSORT_SKIP_CHOWN=1 to skip the chown (e.g. a read-only or already-correct /data,
# or a very large catalog where the recursive pass is noticeably slow).
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  if [ "${PRINTSORT_SKIP_CHOWN:-0}" != "1" ]; then
    chown -R node:node /data 2>/dev/null || chown node:node /data || true
  fi
  exec gosu node "$@"
fi

exec "$@"
