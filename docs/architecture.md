# Architecture

## Overview

PrintSort3D is two packages, run together in dev via `npm run dev` at the repo root:

- **`server/`** — Node + Express + TypeScript. Owns the SQLite catalog, the filesystem scanner, and 3MF metadata/thumbnail extraction.
- **`client/`** — React + TypeScript (Vite). Library grid/table, search/filter, per-file detail view with an interactive three.js viewer, and Settings page for configuring watched folders.

The client talks to the server only over HTTP (`/api/*`, proxied by Vite in dev — see `client/vite.config.ts`). There is no shared code between the two packages; the client's `loadModel.ts` reimplements just enough of the loader logic to match what the server extracts.

## Server

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point: wires up `db`, `paths`, and `createApp()`, then listens on `PORT` (default 3001). |
| `src/app.ts` | Builds the Express app (`createApp()`) without binding a port, so it can be reused directly in tests via Supertest. |
| `src/db.ts` | Opens the SQLite database (Node's built-in `node:sqlite`, no native build step) and runs the schema migrations (`CREATE TABLE IF NOT EXISTS ...`) on load. |
| `src/config.ts` | Reads/writes `config.json` (the list of watched root folders). Creates an empty one on first run. |
| `src/paths.ts` | Resolves and creates the `thumbnails/` and `assets/` cache directories. |
| `src/scanner.ts` | Walks each configured root looking for `.stl` / `.3mf` / `.obj` files, upserts rows into `files`, and flags rows that disappeared as `missing` instead of deleting them. For every file (any extension), computes and stores model dimensions via `dimensions.ts`. For `.3mf` files specifically, also calls into `threeMf.ts` for the primary thumbnail/metadata and `assets.ts` for the full embedded-image gallery. Async — awaits WebP conversion per 3MF file. |
| `src/dimensions.ts` | `computeDimensions(filePath, ext)` — bounding-box width/height/depth, computed once at scan time (not per page view) with no rendering involved: STL (binary or ASCII, auto-detected by whether the file size matches the binary header's triangle count) and OBJ are parsed directly as bytes/text; 3MF vertex data is read out of its zipped XML. Returns `null` if the file can't be parsed or has no vertices — never throws. |
| `src/threeMf.ts` | Treats a `.3mf` as a zip (via `adm-zip`). `extractThreeMfData()` pulls the primary Bambu Lab plate thumbnail (`Metadata/plate_1.png` and fallbacks) plus `Metadata/project_settings.config` (filament type/color, layer height, full raw settings blob). `listThreeMfImages()` returns *every* image under `Metadata/` (all plate renders, "no light" variants, top/pick shots) — a superset used for the gallery. Both return empty/null on anything they can't find rather than throwing. |
| `src/assets.ts` | `cacheThreeMfImages(fileId, filePath)` — calls `listThreeMfImages`, converts each to WebP via `sharp`, writes to `assets/<fileId>/<name>.webp`, returns the saved filenames (best-effort: one bad image is skipped, not fatal). `deleteCachedImages(fileId)` removes that directory — called when a root is removed. |
| `src/routes.ts` | All `/api/*` endpoints (see [api.md](api.md)). |

### Why `node:sqlite` instead of `better-sqlite3`

`better-sqlite3` ships a native addon that needs to be compiled per-platform (`node-gyp`), which is a common source of friction on Windows. Node 22.5+ ships a built-in `node:sqlite` module with a near-identical synchronous API (`db.prepare(sql).get/all/run(...)`), so the app uses that instead — zero native build step, works out of the box.

### Why thumbnails are mostly generated client-side

A `.3mf` file is just a zip, so a Bambu Lab file's embedded plate render can be pulled out directly on the server with no rendering involved. But `.stl` and `.obj` files (and non-Bambu `.3mf` exports) don't embed a thumbnail. Rendering them server-side would require a headless WebGL context (`headless-gl` / `gl`), which — like `better-sqlite3` — needs native bindings that are painful to build on Windows.

Instead, the **client** renders these: `ThumbnailGenerator.tsx` mounts invisibly in the Library grid for any file missing a thumbnail, loads the model with plain (non-React) three.js, renders one offscreen frame, and POSTs the resulting PNG back to the server to cache in `server/thumbnails/`. Once cached, the placeholder never re-renders for that file again.

This logic intentionally avoids `@react-three/fiber`'s declarative renderer for the one-shot offscreen capture — an imperative `THREE.WebGLRenderer` on a detached `<canvas>` is more predictable to reason about and debug than waiting on React's commit/effect timing for a single synchronous render-and-capture.

### Why `sharp` for WebP, unlike everything else

`sharp` is a native addon too, but unlike `better-sqlite3` it ships prebuilt platform binaries (`@img/sharp-win32-x64` etc.) that `npm install` fetches directly — no local compilation, no `node-gyp`, no Windows build-tooling friction. That's the deciding difference; if a future dependency needs native code, check whether it ships prebuilt binaries before ruling it out on Windows-compatibility grounds.

### Why dimensions are computed server-side, at scan time, without three.js

Unlike thumbnails, a bounding box is pure geometry math — no rendering, no WebGL context, so there's no native-binding problem to work around here at all. `dimensions.ts` deliberately doesn't reuse three.js (which the client needs for rendering) or `ThreeMFLoader` (which expects a browser XML parser): it's simple enough to parse STL/OBJ bytes and 3MF's zipped XML directly with no dependencies beyond `adm-zip` (already used for thumbnails). Computing it once per scan and storing it (`dimension_x/y/z` on `files`) means the Detail page just reads a number instead of re-parsing the whole model (sometimes tens of MB) on every visit.

One real-world wrinkle: Bambu Studio / OrcaSlicer 3MF exports (the 3MF Production Extension) split geometry across multiple part files — the root `3D/3dmodel.model` is often just a manifest of `<components>` referencing `3D/Objects/object_N.model` for the actual vertices. `computeDimensions` unions vertices across *every* `.model` entry in the zip rather than assuming the root file has the geometry — an early version that only read the first `.model` entry silently produced `null` dimensions for every real Bambu export. Per-component transform matrices aren't applied (this is a raw union of local vertex coordinates across parts), which can inflate the box for objects assembled from far-apart sub-components — an acceptable trade-off for avoiding a full matrix-transform pipeline, and no worse than what the client's own combined-scene bounding box would show.

### Why there's a `scanner_version` column

New scan-time processing (dimensions, then 3MF images) only runs on a row when it's newly inserted or its `mtime` changed — a rescan of an untouched folder is meant to be cheap. But that meant a catalog scanned before these features existed would **never** pick them up: the file's `mtime` on disk never changes just because the app added new columns, so a rescan kept taking the "nothing changed" path forever, regardless of how many times you clicked "Rescan now".

`scanner_version` on `files` fixes this: it's bumped (`CURRENT_SCANNER_VERSION` in `scanner.ts`) whenever new backfill-worthy processing is added. On each scan, a row is reprocessed if its `mtime` changed *or* its `scanner_version` is behind — after which its `scanner_version` is set to current, so it goes back to being skipped. This is deliberately not inferred from whether `dimension_x` is `NULL`, because `NULL` is also the legitimate result for a file with no parseable geometry — inferring "needs backfill" from a nullable data column would reprocess that file forever. If you add another kind of scan-time processing that existing rows should pick up, bump `CURRENT_SCANNER_VERSION` rather than reaching for a new nullable-column check.

### Failure isolation in the scanner

A single corrupt or unreadable file must not abort a scan of everything else. This is enforced at two levels:

1. **Per zip-entry, inside `threeMf.ts`/`dimensions.ts`.** `adm-zip`'s `entry.getData()` throws (`ADM-ZIP: Descriptor data is malformed`) on a bad CRC/truncated entry — real-world Bambu 3MF exports have hit this. `listThreeMfImages()`, `extractThreeMfData()`'s thumbnail-candidate loop, and `parseThreeMfDimensions()`'s per-part-file loop each wrap their `getData()` calls individually, so one malformed image/part file is skipped while the rest of the same archive is still processed normally.
2. **Per file, inside `scanner.ts`.** The whole per-file body of `runScan()`'s loop is wrapped in `try/catch` — an error is logged (`console.error`) and the loop moves on to the next file, rather than aborting the scan for every file after it. A file whose existing DB row is reached before the failure is still recorded in `seenFileIds`, so a processing error doesn't also wrongly flag it `missing`.

`POST /api/scan`'s route handler also has its own `try/catch` as a last-resort net (returns `500` instead of an unhandled rejection) for anything that isn't a per-file failure, e.g. an unreadable root path — Express 4's async handlers don't automatically catch rejected promises, so without this an unexpected throw could crash the whole process rather than just failing the one request.

## Client

| File | Responsibility |
|---|---|
| `src/api.ts` | Typed fetch wrapper for every server endpoint. All server calls go through this file. |
| `src/App.tsx` | App shell + sidebar: "All models" / "Duplicates" links, the **Sources** list (one row per watched root, each with a per-source rescan icon), and — under the currently-selected source — a **collapsible folder tree** built client-side from `GET /api/folders` (per-folder recursive counts as badges). Clicking a folder navigates to `/?root=<label>&folder=<path>`; ancestors of the active folder auto-expand. |
| `src/loadModel.ts` | `loadModelAsObject3D(ext, arrayBuffer)` — picks the right three.js loader (`STLLoader` / `OBJLoader` / `ThreeMFLoader`) and returns an `Object3D`. `frameObject(object, camera)` — centers the object at the origin and positions/sizes the camera to frame it, based on its bounding box (for camera framing only — the *displayed* dimensions on the Detail page come from the server, not from re-deriving them here). Shared by the interactive viewer and the thumbnail generator. |
| `src/ModelViewer.tsx` | Interactive `@react-three/fiber` viewer with `OrbitControls`, used on the Detail page. Loads the server-baked `meshUrl` by default; `preferRaw` (Detail's "Load full model" toggle) forces an in-browser parse of the raw source file instead. |
| `src/ThumbnailGenerator.tsx` | Invisible, imperative (non-R3F) one-shot renderer: fetch raw file → parse → render offscreen → capture PNG → upload. See the architecture note above for why this isn't done through R3F. |
| `src/pages/Library.tsx` | Grid/table toggle, search box, tag/extension/`root`/`folder` filters, and pagination (page-size selector: 10/15/20/30/40/50, default 20 — passed to `GET /api/files` as `page`/`pageSize`; changing any filter or the page size resets to page 1). All filter state lives in the URL. When a `folder` is active the heading shows the folder name plus a clickable breadcrumb back up to the root. Mounts a `ThumbnailGenerator` for each file missing a thumbnail (a handful at a time), scoped to the current page. |
| `src/pages/Detail.tsx` | Per-file view: `ModelViewer`, a clickable folder-path breadcrumb (each segment links to that folder's filtered library view; absolute path on hover), model dimensions (`file.dimensions` straight from the API — computed once server-side at scan time, not re-parsed by the client), notes, tag editor, a read-only filament/layer-height panel for 3MF files with extracted metadata, and — for 3MF files with a non-empty `embeddedImages` list — a thumbnail gallery of every image embedded in the file. |
| `src/pages/Settings.tsx` | CRUD for watched root folders (backed by `/api/roots`), a per-folder "Rescan" button (`POST /api/scan` with `{ root: label }`), and a "Rescan all" trigger (`POST /api/scan` with no body). The sidebar (`App.tsx`) mirrors this: a per-source rescan icon on each Sources row plus the all-sources rescan in the section header. |

## Data model

SQLite, four tables (defined in `server/src/db.ts`):

- **`roots`** — `id, path, label`. Mirrors `config.json`; kept in the DB too so `files.root_id` has something stable to reference even if `config.json` is hand-edited.
- **`files`** — one row per discovered model file: path info (`root_id`, `relative_path`, `filename`, `ext`), filesystem stats (`size_bytes`, `mtime`), catalog fields (`notes`, `thumbnail_path`, `missing`), geometry (`dimension_x`, `dimension_y`, `dimension_z` — computed for every file type, not just 3MF), 3MF-derived fields (`filament_type`, `filament_color`, `layer_height`, `slicer_metadata_json`, `embedded_images_json` — a JSON array of cached WebP filenames under `assets/<id>/`), and `scanner_version` (see below). All were added via `ALTER TABLE` migrations in `db.ts` that run on startup, so they're safe on databases created before these columns existed — existing rows backfill on their *next rescan* (not automatically at migration time; the scanner has to actually run).
- **`tags`** — `id, name` (unique, stored lowercase).
- **`file_tags`** — join table, `(file_id, tag_id)`.

`missing` exists so that a file temporarily unavailable (e.g. an external drive unplugged) doesn't lose its tags/notes/thumbnail — it just gets flagged and dimmed in the UI, and un-flagged automatically if it reappears on a later scan.

There is **no folders table** — the sidebar folder tree is derived on the fly from the directory portion of every file's `relative_path` (`GET /api/folders`), and the `folder` filter on `GET /api/files` is a separator-normalized `LIKE '<folder>/%'` prefix match.

> Some `files` columns added after this doc was first written aren't listed above — e.g. `content_hash` / `geometry_hash` (duplicate detection), `plates_json` / `plate_size_json` (multi-plate 3MFs), `filaments_json` (multi-material), `archive_entry_count` (`.zip`), and `mesh_path` (the server-baked render mesh). They follow the same guarded-`ALTER TABLE` + `scanner_version` backfill pattern; see `server/src/db.ts` and CLAUDE.md for the full current list.

## Request flow: adding a folder and scanning

1. User adds a folder on the Settings page → `PUT /api/roots` writes `config.json` and upserts a `roots` row.
2. User clicks "Rescan now" → `POST /api/scan` → `runScan()` walks every configured root recursively, filtering to `.stl`/`.3mf`/`.obj`/`.zip`.
3. For each file: if it's new, or its `mtime` changed, or its `scanner_version` is behind the code's current version (see below), (re)compute and store its bounding-box dimensions via `dimensions.ts` (all file types); for `.3mf` files also pull an embedded thumbnail + metadata via `threeMf.ts` and cache every embedded image as WebP via `assets.ts`.
4. Any previously-known file not seen this pass gets `missing = 1`.
5. Client reloads `GET /api/files`, renders the grid. Files still missing a `thumbnailUrl` (STL/OBJ, or a 3MF with no embedded thumbnail) each mount a `ThumbnailGenerator`, which renders and uploads a PNG, which is cached in `server/thumbnails/<id>.png` and referenced from then on.

## Testability decisions

`db.ts`, `config.ts`, and `paths.ts` all read their file locations from environment variables (`DB_PATH`, `CONFIG_PATH`, `THUMBNAILS_DIR`) with the normal on-disk locations as defaults. Tests set these to a fresh temp directory and dynamically `import()` the modules afterward (static imports are hoisted and would run before the env vars are set), giving each test file a fully isolated database/config/thumbnail-cache with no shared state between test files. See [testing.md](testing.md).
