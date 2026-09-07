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
| `HOST` | `0.0.0.0` (in image) | Interface the server binds. The image binds all interfaces so the published port works; how exposed that actually is depends on your `ports:` / `-p` mapping. |

### Access control

The API has **no authentication by default**. `docker-compose.yml` publishes the port on
`127.0.0.1` only, so out of the box it's reachable just from the Docker host. To expose it on
your network, change the `ports:` mapping to `"3001:3001"` **and** set one or more of:

| Var | Effect |
|---|---|
| `PRINTSORT_PASSWORD` | HTTP Basic auth on every request (browser prompts; no client setup). |
| `PRINTSORT_READONLY=1` | Reject all catalogue edits — browse-only. |
| `PRINTSORT_ROOTS_LOCKED=1` | Forbid changing the watched-folder list via the API (the mounts already own it). |
| `PRINTSORT_CORS_ORIGINS` | Comma-separated allowlist, only if a browser app on another origin calls the API. |

A cross-origin CSRF guard is always on. See [api.md](api.md#access-control).

## docker compose (recommended)

A starter [`docker-compose.yml`](../docker-compose.yml) is in the repo root. It pulls the
published image `ghcr.io/amospainter/printsort3d:latest` and mounts one folder via
`MODELS_DIR`; add more `- host:/models/<name>:ro` lines for additional sources.

```sh
MODELS_DIR=/srv/3d-prints docker compose up -d
```

Open `http://localhost:3001` — the folder is already scanned and listed as a source.

Update later with:

```sh
docker compose pull && docker compose up -d
```

To build the image from a checkout instead of pulling it, comment the `image:` line in
`docker-compose.yml` back to `build: .` and use `docker compose up -d --build`.

## Plain docker

```sh
docker run -d --name printsort3d \
  -p 127.0.0.1:3001:3001 \
  -v printsort3d-data:/data \
  -v /srv/3d-prints:/models/prints:ro \
  -v /srv/downloads/stl:/models/downloads:ro \
  --restart unless-stopped \
  ghcr.io/amospainter/printsort3d:latest
```

(Swap in `docker build -t printsort3d .` and run `printsort3d` if you want a local build.)

## Publishing the image

After publishing a new master version, ship the matching Docker package with the
standalone script (it's not wired into any git hook):

```sh
npm run publish:docker          # bash scripts/publish-docker.sh
```

or directly:

```sh
./scripts/publish-docker.sh                 # bash / git-bash / WSL
pwsh ./scripts/publish-docker.ps1           # Windows PowerShell
```

It reads the version from `package.json`, builds `linux/amd64,linux/arm64`, and
pushes `ghcr.io/amospainter/printsort3d:<version>` and `:latest` straight to the
registry. Pass a version to override (`./scripts/publish-docker.sh 0.2.0`), or set
`PLATFORM=linux/amd64` for a faster single-arch build.

The multi-arch build needs a buildx builder on the `docker-container` driver (the
default `docker` driver can't cross-build). The script creates one named
`printsort3d-builder` on first run and reuses it after — nothing to set up. (If you
prefer, enabling the containerd image store in Docker Desktop's settings also works,
and you can then delete that builder with `docker buildx rm printsort3d-builder`.)

One-time auth (PAT with `write:packages`):

```sh
echo "$GITHUB_PAT" | docker login ghcr.io -u amospainter --password-stdin
```

## Notes

- **Windows host folders:** with Docker Desktop, mount them with the usual translated path,
  e.g. `-v "C:\Users\me\3D Prints:/models/prints:ro"`.
- **The catalog stores container paths** (`/models/<name>`). If you rename a mount, its old
  catalog entries get flagged *missing*; the new name comes in as a fresh source. Keep mount
  names stable.
- **Upgrading:** `docker compose pull && docker compose up -d` (or `up -d --build` for a
  local build). Schema migrations in `db.ts` run on startup; the `/data` volume carries your
  catalog across versions.
- **Thumbnails for STL/OBJ** are still rendered in your browser (WebGL) the first time you
  view those files in the library, then cached under `/data`. This is unchanged by Docker.
- **`/data` permissions are handled for you.** The container starts as root only long enough
  for its entrypoint to `chown` `/data` to the unprivileged `node` user (UID 1000), then
  drops to that user via `gosu` to run the server — so a bind mount owned by root on the host
  works without any manual `chown`. Set `PRINTSORT_SKIP_CHOWN=1` to skip that step (read-only
  `/data`, or a very large catalog where the recursive chown is slow).
