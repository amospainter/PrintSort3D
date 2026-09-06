# Testing

Both packages use [Vitest](https://vitest.dev/). Run everything from the repo root:

```sh
npm test
```

Or per package:

```sh
npm test --prefix server
npm test --prefix client
```

Add `-- --watch` (e.g. `npm test --prefix server -- --watch`) to run in watch mode during development.

## Server tests (`server/src/*.test.ts`)

| File | Covers |
|---|---|
| `threeMf.test.ts` | `extractThreeMfData()` against on-the-fly zip fixtures (built with `adm-zip` in the test itself): Bambu plate thumbnail + filament/layer-height extraction, thumbnail-candidate fallback order, scalar vs. array config values, corrupt/non-zip files, invalid JSON in `project_settings.config`. `listThreeMfImages()`: returns every `Metadata/` image (not just the primary candidates), excludes non-`Metadata/` and non-image entries, empty list for no images or a corrupt file. Two regression tests reproduce the real "ADM-ZIP: Descriptor data is malformed" crash (a malformed zip entry's `getData()` throws) by mocking `adm-zip` so one named entry throws while the rest of the archive still decodes — see "Mocking `adm-zip`" below. |
| `dimensions.test.ts` | `computeDimensions()` per format: binary STL (a hand-built buffer with known triangle vertices), ASCII STL, OBJ (ignoring `vt`/`vn`/`vp` lines), and 3MF (vertices read from a fixture `.model` XML, including a union across multiple `<object>`s). Regression test for real Bambu/OrcaSlicer exports: geometry split across `3D/Objects/object_N.model` part files with the root `3D/3dmodel.model` as just a manifest — an earlier version only read the first `.model` entry and silently returned `null` for every real Bambu file. Also: zero-triangle/no-vertex files, missing `.model` entry, corrupt/non-zip 3MF, unsupported extension, nonexistent file, and (same `adm-zip` mock as `threeMf.test.ts`) a malformed part file alongside a good one — all return `null`/skip cleanly rather than throwing. |
| `assets.test.ts` | `cacheThreeMfImages()`: converts each embedded image to a real WebP file under `ASSETS_DIR/<fileId>/` (asserts the `WEBP` magic bytes, not just that a file exists), skips undecodable images without throwing, empty array for a 3MF with no images. `deleteCachedImages()`: removes the directory tree, no-ops (doesn't throw) if it doesn't exist. `saveThumbnail()`/`thumbnailFilePath()`: writes/locates `thumbnail.png` under the same `ASSETS_DIR/<fileId>/`. |
| `scanner.test.ts` | `runScan()` end-to-end against real files in a temp directory: adding new files, idempotent rescans, 3MF metadata/thumbnail extraction wired into a scan, embedded images cached as WebP during a scan, dimensions computed and stored for new/changed files of any extension (asserted against hand-built STL/3MF fixtures with known geometry), `NULL` dimensions left alone for files with no parseable geometry, and missing-file flagging/un-flagging as files are deleted and recreated. Two `scanner_version` backfill regression tests: a row with `scanner_version` reset to 0 (simulating a pre-existing catalog.db) gets its dimensions/3MF metadata recomputed on rescan *even with `mtime` unchanged*, and — the counterpart bug this guards against — a file with no parseable geometry is *not* reprocessed on every subsequent scan just because `dimension_x` stays `NULL`. `runScan()` is async (awaits WebP conversion), so every call site in tests is `await`ed. |
| `routes.test.ts` | Every `/api/*` endpoint via `createApp()` + Supertest: search/filter, `GET /api/files` pagination (page/pageSize slicing, past-the-end pages, pageSize clamped to the max), tag dedup+lowercasing, 404s, thumbnail upload then serve back via `GET /api/files/:id/thumbnail` (404 when none cached), `/api/assets/:fileId/:filename` serving cached WebP images and rejecting non-webp/traversal-looking filenames, the `/api/raw/:id` path-traversal guard (a record's `relative_path` is tampered with directly in the DB to simulate an escape attempt), that `dimensions` is `null` vs. populated depending on whether the file has parseable geometry, and that removing a root via `PUT /api/roots` deletes that root's files/thumbnails/cached-images/tag-links instead of leaving them orphaned. |

### Test isolation

`db.ts`, `config.ts`, and `paths.ts` read their file locations from `DB_PATH`, `CONFIG_PATH`, and `ASSETS_DIR` env vars (falling back to the normal on-disk locations when unset). Each test file:

1. Creates its own temp directory (`fs.mkdtempSync`).
2. Sets those env vars to point inside it.
3. **Dynamically imports** `db`, `config`, `scanner`, `assets`, and `app` (`await import('./db')`, etc.) — not static imports, since static imports are hoisted above the env-var assignments and would run against the real default paths.

Vitest isolates each test file's module graph by default, so this pattern doesn't leak env vars or module state between files — confirmed by running the full suite together, not just file-by-file.

`afterAll` closes the SQLite handle (`db.close()`) before deleting the temp directory; on Windows, deleting a directory containing a still-open DB file can throw, so that removal is wrapped in a `try/catch` (a cleanup nicety, not something a test asserts on).

### Mocking `adm-zip` to reproduce a malformed zip entry

`threeMf.test.ts` and `dimensions.test.ts` each reproduce the real "ADM-ZIP: Descriptor data is malformed" crash deterministically, without hand-crafting actually-corrupted zip bytes. The approach: `vi.mock('adm-zip', ...)` wraps the real module so that a specific entry name (set via a `vi.hoisted()`-declared mutable `corruptState.entryName`) has its `getData()` replaced with a function that throws.

The one non-obvious part: **`adm-zip` assigns `getEntries`/`getEntry` as own instance properties inside its constructor, not as prototype methods.** A first attempt at `class PatchedAdmZip extends RealAdmZip { getEntry(name) {...} }` silently never ran the override — the instance property set by the real constructor shadows a subclass's prototype method in JS property lookup. The fix wraps the *constructed instance* directly instead: `new RealAdmZip(path)`, then reassign `real.getEntries`/`real.getEntry` on that instance before returning it from a plain factory function. If you need to mock another `adm-zip` method the same way, mutate the instance post-construction, not the prototype.

## Client tests (`client/src/*.test.ts`)

| File | Covers |
|---|---|
| `loadModel.test.ts` | `frameObject()`: recenters an object's bounding box to the origin, scales camera distance with object size, keeps `near > 0` and `far > near`, doesn't throw on a zero-volume object. `loadModelAsObject3D()`: parses a real (inline ASCII) STL into a `THREE.Mesh`, is case-insensitive on the extension, rejects unsupported extensions. (Bounding-box *size* itself is no longer computed client-side — see `dimensions.test.ts` on the server.) |
| `api.test.ts` | The `api` fetch wrapper against a mocked `global.fetch` (`vi.stubGlobal`): query-string building (including omitting empty params), PATCH body shape, error messages on non-ok responses, and `rawFileUrl()`. |

These run with `environment: 'node'` (see `client/vitest.config.ts`) since none of the current tests touch the DOM — they test pure logic (`three.js` math/parsing, `fetch` call shapes), not rendered components. If component-level tests are added later, switch that test's file (or the whole config) to `environment: 'jsdom'` (already installed as a dev dependency).

## What isn't covered (by design, so far)

- No React component rendering tests (`ModelViewer`, `ThumbnailGenerator`, page components) — these are thin wrappers around three.js/R3F and the `api` client, both of which are tested directly. Adding these would mean bringing in `@testing-library/react` and a jsdom WebGL shim.
- No end-to-end/browser tests — the app was smoke-tested manually against real STL/OBJ/3MF files (including real Bambu Lab exports) during development; see the architecture doc for what that verified.
