# API Reference

Base URL in dev: `http://localhost:3001/api` (the client proxies `/api/*` to this automatically — see `client/vite.config.ts`). All bodies are JSON unless noted.

## File object shape

Returned by every endpoint below that mentions "a file object":

```ts
{
  id: number,
  filename: string,
  ext: string,                    // ".stl" | ".3mf" | ".obj"
  sizeBytes: number,
  mtime: number,                  // file's last-modified time, ms since epoch
  addedAt: number,                // when the row was first inserted, ms since epoch
  notes: string,
  thumbnailUrl: string | null,    // e.g. "/api/files/12/thumbnail", or null if not generated yet
  missing: boolean,                // true if not found on the last scan
  root: { label: string, path: string },
  relativePath: string,           // path relative to root.path
  filamentType: string | null,    // from 3MF project_settings.config, if present
  filamentColor: string | null,   // first slot only; see `filaments` for the full multi-color list
  filaments: { color: string, type: string | null }[],  // every filament slot from project_settings.config (multi-color / AMS), color normalized to "#RRGGBB"; [] if none
  meshUrl: string | null,         // "/api/files/:id/mesh" server-baked render mesh (STL/OBJ/3MF), else null
  layerHeight: string | null,
  slicerMetadata: object | null,  // full raw parsed 3MF slicer settings, if present
  embeddedImages: string[],       // "/api/assets/:id/:name.webp" URLs for every image embedded in a 3MF, else []
  dimensions: { x: number, y: number, z: number } | null,  // bounding-box size, computed server-side at scan time
  tags: string[],                 // lowercase, deduped
  bedSize: { x: number, y: number },      // build-plate footprint (mm) for the viewer: declared 3MF size, else the configured default
  plateSizeSource: "file" | "default",    // whether bedSize came from the file's slicer settings or the app default
  contentHash: string | null,     // SHA-256 of raw file bytes; identical for byte-for-byte duplicate files
  geometryHash: string | null,    // order/translation-invariant mesh fingerprint; identical across the same model in a different format
  duplicateCount: number,         // count of other files sharing contentHash or geometryHash
  duplicates: DuplicateEntry[],   // present only on GET/PATCH /api/files/:id and POST /api/files/:id/rescan, not in list responses
  archiveEntryCount: number | null,   // non-null only for .zip files: count of model files (.stl/.3mf/.obj) inside
  plates: PlateEntry[],           // multi-plate 3MF grouping; [] for non-3MF or single-plate files
}

// DuplicateEntry: { id: number, filename: string, relativePath: string, rootLabel: string, matchType: "exact" | "geometry" }
// PlateEntry: { index: number, images: string[], buildItemIndices?: number[], name?: string } — images are "/api/assets/:id/:name.webp" URLs; name is the plate's human-assigned label from Bambu/Orca's plate-tab rename, absent if never renamed
```

## `GET /api/files`

List/search/filter the catalog.

Query params (all optional):

| Param | Meaning |
|---|---|
| `query` | Substring match against `filename` (case-insensitive `LIKE %query%`) |
| `root` | Only files under the root folder with this exact `label` (see `GET /api/roots`) |
| `folder` | Only files at or below this directory, relative to the root (`/`-joined, e.g. `vehicles/cars`). Recursive; separator-normalized so it works regardless of how `relative_path` was stored. Usually combined with `root`. |
| `tags` | Comma-separated tag names; a file must carry **every** listed tag (AND, not OR) |
| `ext` | Only files with this extension (`.stl`, `.3mf`, `.obj`, `.zip` — leading dot optional) |
| `duplicatesOnly` | `1` or `true` — only files that share a `content_hash` or `geometry_hash` with another file |
| `sort` | One of `name`, `size`, `added`, `mtime`. Defaults to `added`, always descending. |
| `page` | 1-based page number. Defaults to `1`. |
| `pageSize` | Items per page. Defaults to `60`, clamped to a max of `200`. |

Returns a paginated envelope, not a bare array:

```ts
{
  items: FileEntry[],
  total: number,       // total matching rows across all pages
  page: number,        // echoes the (clamped) requested page
  pageSize: number,    // echoes the (clamped) requested pageSize
  totalPages: number,  // always >= 1, even when total is 0
}
```

Requesting a `page` past the end returns `items: []` with `total`/`totalPages` still reflecting the full result set (not an error).

## `GET /api/files/:id`

Returns a single file object, or `404 { error: "not found" }`.

## `PATCH /api/files/:id`

Update notes and/or tags for a file. Body (both optional, at least one expected):

```ts
{ notes?: string, tags?: string[] }
```

- `tags`, if provided, **replaces** the file's full tag set (not merged). Each tag is trimmed and lowercased; empty strings are dropped; new tag names are created automatically.
- Returns the updated file object, or `404` if the id doesn't exist.

## `GET /api/tags`

Returns every distinct tag in use, alphabetically by name:

```ts
{ name: string, color: string | null, count: number }[]
```

`color` is an explicit hex string (`#rrggbb`) chosen in Settings, or `null` to let the client pick a stable colour from its preset palette. `count` is how many files carry the tag.

## `PATCH /api/tags/:name`

Sets or clears a tag's colour. Body: `{ color: string | null }` — a `#rgb`/`#rrggbb` hex string, or `null` to revert to the auto palette colour. Returns the updated tag object, `400` for a malformed colour, `404` if the tag doesn't exist.

## `DELETE /api/tags/:name`

Removes the tag from every file and deletes it. Returns `{ ok: true }`, or `404` if the tag doesn't exist.

## `GET /api/settings`

Returns app-wide settings: `{ defaultPlateSize: { x: number, y: number } }` (mm).

## `PUT /api/settings`

Updates app-wide settings. Body: `{ defaultPlateSize: { x: number, y: number } }` with positive values (mm). Returns the saved settings, or `400` if `x`/`y` aren't positive.

## `POST /api/scan`

Triggers a rescan. With no body (or `{}`), scans every folder in `config.json` (via `roots`). With `{ "root": "<label>" }`, scans only that one watched folder — the walk, new/changed detection, and the missing-flag pass are all scoped to that root, so other roots' rows are untouched; `404` if no configured root has that label. Returns:

```ts
{ added: number, updated: number, missing: number }
```

`missing` is the count of files flagged missing this pass (not found on disk within their configured root), not a running total.

Async and can take a while on a large library — for each new or changed `.3mf` file, it also converts every embedded image to WebP (via `sharp`) before the response resolves.

## `POST /api/files/:id/rescan`

Forces one file through the same scan-time processing as `POST /api/scan` (dimensions, 3MF metadata/plates, archive entry count, content/geometry hashing), regardless of whether its `mtime` or `scanner_version` would normally trigger reprocessing. No body. Meant for quick manual re-testing of a single file rather than waiting on a full library scan.

Returns the file's full record (same shape as `GET /api/files/:id`, including `duplicates`) plus `rescanStatus: 'ok' | 'missing'` — `'missing'` means the file wasn't found on disk (it's flagged `missing` in the response and no further processing ran). `404` if the id doesn't exist.

## `GET /api/folders`

Returns the directory tree derived from every file's `relative_path` (there is no folders table). Every ancestor directory of every file is included — intermediate directories with no direct files still appear — each with a **recursive** file count:

```ts
{ root: string, path: string, name: string, fileCount: number }[]
```

`root` is the watched-folder label; `path` is `/`-joined relative to that root; `name` is the last segment. Sorted by `root` then `path`. Powers the sidebar folder tree; pair a row's `root`/`path` with the `folder` param on `GET /api/files`.

## `GET /api/roots`

Returns the configured root folders: `{ label: string, path: string, managed?: boolean }[]`.

`managed: true` marks a root injected from the environment (`PRINTSORT_ROOTS` or
`PRINTSORT_MODELS_DIR` — see [docker.md](docker.md)) rather than added through Settings.
Managed roots aren't written to `config.json`, are re-derived on every request, and can't be
removed via `PUT /api/roots`. User-added roots have no `managed` key.

## `PUT /api/roots`

Replaces the **user-managed** portion of the root folder list. Body: `{ label: string, path:
string }[]` (a bare array, not wrapped in an object). Returns the effective list — the roots
as saved plus any managed roots re-derived from the environment — or `400` if the body isn't
an array. Managed roots in the payload are ignored on write and can't be removed; omitting
one does **not** delete its catalog entries.

Note: this only updates `config.json` and the `roots` table — it does **not** scan. Call `POST /api/scan` afterward to pick up files from a newly added root.

## `POST /api/files/:id/thumbnail`

Upload a generated thumbnail for a file (used by the client's in-browser renderer for STL/OBJ/non-Bambu-3MF files). Body:

```ts
{ imageBase64: string }  // a data URL (e.g. "data:image/png;base64,...") or bare base64
```

Saves to `server/assets/<id>/thumbnail.png` and updates the file's `thumbnail_path`. Returns `{ ok: true }`, or `404` if the id doesn't exist, or `400` if `imageBase64` is missing.

## `GET /api/files/:id/thumbnail`

Serves a file's cached thumbnail PNG from `server/assets/<id>/thumbnail.png`. `400` if `:id` isn't an integer, `404` if no thumbnail has been cached for it yet.

## `GET /api/raw/:id`

Streams the actual model file from disk (used by the client to fetch bytes for rendering — both the interactive viewer and the thumbnail generator).

- Resolves `root.path + relativePath`, and rejects with `400 { error: "invalid path" }` if the resolved path would land outside the file's configured root (a defense against a corrupted/tampered `relative_path` escaping via `../`).
- Returns `404` if the file's DB record doesn't exist, or if the resolved path doesn't exist on disk (e.g. flagged `missing`).

## `GET /api/assets/:fileId/:filename`

Serves a cached WebP image extracted from a 3MF file's `Metadata/` folder (plate renders, top/pick shots, etc. — see `embeddedImages` on the file object). `:fileId` must be a bare integer and `:filename` must match `^[a-zA-Z0-9._-]+\.webp$`; either failing returns `400` before touching the filesystem. Returns `404` if the file doesn't exist on disk (e.g. the source 3MF had no embeddable images, or hasn't been rescanned since this feature was added).

## `GET /api/files/:id/mesh`

Serves the server-baked render mesh — parsed once at scan time so the viewer skips unzipping
and DOM-parsing the source file in the browser. Gzipped on disk and sent with
`Content-Encoding: gzip` (`fetch` inflates transparently); `Content-Type:
application/octet-stream`. Blob layout (pre-gzip): `"PSM1"` magic (uint32LE), `partCount`
(uint32LE — one part per 3MF `<build><item>`, STL/OBJ = 1), then per part `floatCount`
(uint32LE), `indexCount` (uint32LE, `0` ⇒ non-indexed triangle soup), `flags` (uint32LE,
bit0 = hasPaint), `Float32LE * floatCount` world-space positions, `Uint32LE * indexCount`,
and — iff hasPaint — `Uint8 * triangleCount` 0-based filament slots (4-byte padded). `404`
when the file has no baked mesh (`meshUrl` is null — unsupported, corrupt, or predates
scanner v8).

## `GET /api/files/:id/archive`

Lists the 3D model files (`.stl`/`.3mf`/`.obj`) inside a scanned `.zip` archive, read live (not cached): `{ path: string, ext: string, sizeBytes: number }[]`. `400` if the file isn't a `.zip`, `404` if the id doesn't exist or is missing on disk.

## `GET /api/files/:id/archive-raw?path=...`

Streams the raw bytes of one entry inside the archive (`Content-Type: application/octet-stream`) — `path` must exactly match one of the paths from `GET /api/files/:id/archive` (re-validated server-side against the archive's actual contents, not trusted as given). `400` if the file isn't a `.zip` or `path` is missing, `404` if the entry doesn't exist.
