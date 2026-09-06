# Running PrintSort3D in Docker

The image is a single self-contained unit: the Node server serves the API **and** the
built React client on one port (`3001`), so there's no separate client container or reverse
proxy to set up. It runs on Linux (amd64/arm64) and on Docker Desktop for Windows/macOS.

## Layout inside the container

| Path | What it is | How to mount it |
|---|---|---|
| `/data` | All mutable state — `catalog.db` (SQLite), `config.json`, `assets/` (per-file thumbnail + image + baked-mesh cache) | A named volume or a bind mount. **Persist this** or you lose your catalog, tags, and notes. |
| `/models` | Where you mount your folders of `.stl` / `.3mf` / `.obj` / `.zip` files | One or more read-only (`:ro`) bind mounts, one per folder, each under its own name. |
| `3001` | HTTP port | Publish to a host port. |

The server reads its paths from env vars (`DB_PATH`, `CONFIG_PATH`, `ASSETS_DIR`,
`CLIENT_DIST`, `PORT`) — the Dockerfile already points the first three at
`/data`, so you normally don't touch them. (Upgrading a volume that still has a
`/data/thumbnails` from an older image? Set `THUMBNAILS_DIR=/data/thumbnails` once so
`db.ts` migrates those PNGs into `/data/assets/<id>/thumbnail.png`, then remove it.)

## Model folders are picked up automatically

The image sets `PRINTSORT_MODELS_DIR=/models` and `SCAN_ON_STARTUP=true`, so:

- **Every immediate subdirectory of `/models`** is registered as a watched source
  automatically — the subdirectory's name becomes the source label.
- The catalog is **scanned once on container start**, so mounted files appear in the library
  without anyone opening Settings.

To catalogue several separate host folders, mount each under its own name in `/models`:

```yaml
    volumes:
      - printsort3d-data:/data
      - /srv/3d-prints:/models/prints:ro
      - /srv/downloads/stl:/models/downloads:ro
      - /mnt/nas/3d:/models/nas:ro
```

That yields three sources — **prints**, **downloads**, **nas** — in the sidebar, each
scanned and browsable. They show up in Settings marked *"from environment"* with no Remove
button (they're owned by the deployment); the per-folder **Rescan** button still works. You
can still add extra folders by hand in Settings — those persist to `/data/config.json`.

### Env vars that control this

| Var | Default (in image) | Effect |
|---|---|---|
| `PRINTSORT_MODELS_DIR` | `/models` | Each immediate subdirectory becomes a watched source. Set empty to disable auto-discovery. |
| `PRINTSORT_ROOTS` | *(unset)* | Explicit list, `;`- or newline-separated, each entry `Label=/path` or just `/path`. Combined with the above. |
| `SCAN_ON_STARTUP` | `true` | Scan every source once when the server starts. Set `false` to only scan from the UI. |

## docker compose (recommended)

A starter [`docker-compose.yml`](../docker-compose.yml) is in the repo root. It mounts one
folder via `MODELS_DIR`; add more `- host:/models/<name>:ro` lines for additional sources.

```sh
MODELS_DIR=/srv/3d-prints docker compose up -d --build
```

Open `http://localhost:3001` — the folder is already scanned and listed as a source.

## Plain docker

```sh
docker build -t printsort3d .

docker run -d --name printsort3d \
  -p 3001:3001 \
  -v printsort3d-data:/data \
  -v /srv/3d-prints:/models/prints:ro \
  -v /srv/downloads/stl:/models/downloads:ro \
  --restart unless-stopped \
  printsort3d
```

## Notes

- **Windows host folders:** with Docker Desktop, mount them with the usual translated path,
  e.g. `-v "C:\Users\me\3D Prints:/models/prints:ro"`.
- **The catalog stores container paths** (`/models/<name>`). If you rename a mount, its old
  catalog entries get flagged *missing*; the new name comes in as a fresh source. Keep mount
  names stable.
- **Upgrading:** `docker compose up -d --build` again. Schema migrations in `db.ts` run on
  startup; the `/data` volume carries your catalog across versions.
- **Thumbnails for STL/OBJ** are still rendered in your browser (WebGL) the first time you
  view those files in the library, then cached under `/data`. This is unchanged by Docker.
- **`/data` permissions are handled for you.** The container starts as root only long enough
  for its entrypoint to `chown` `/data` to the unprivileged `node` user (UID 1000), then
  drops to that user via `gosu` to run the server — so a bind mount owned by root on the host
  works without any manual `chown`. Set `PRINTSORT_SKIP_CHOWN=1` to skip that step (read-only
  `/data`, or a very large catalog where the recursive chown is slow).
