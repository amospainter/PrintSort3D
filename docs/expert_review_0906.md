# Expert review — 2026-09-06

A read of the whole `server/` and `client/` codebase from two angles: web-app engineering
(security, correctness, performance) and 3D-printing domain fit (what a print-file catalogue
actually needs to do).

Findings marked **measured** were verified against the live dev server and the real
`server/catalog.db` (1,512 files, 32 GB of models, 807 × 3MF / 545 × STL / 97 × ZIP / 63 × OBJ).
Everything else is from reading the code.

**Update 2026-09-06 (later that day):** most of the High/Medium items are now fixed — see the
Status column and the per-finding notes. The `slice_info.config` feature from §16.1 was also
built.

**Update 2026-09-07:** §10, §14 and §15 done, then a second pass closed the rest of the
non-feature findings — §4 (worker-thread pool via `SCAN_WORKERS` + rich `GET /api/scan/status`
progress + `POST /api/scan/cancel` + `mode: 'reprocess-stale'` resume/backfill), §5 (dimensions
and the geometry hash now come from the baked mesh — `CURRENT_SCANNER_VERSION` 12), the
`duplicate_count` correlated subquery (materialized column), and the `/archive-raw` double
zip open. Only the §16 feature set beyond §16.1 remains.

---

## Priority summary

| # | Finding | Severity | Kind | Status |
|---|---|---|---|---|
| 1 | No auth + wide-open CORS ⇒ any website can read and rewrite the catalogue | **High** | Security | **Fixed** — opt-in Basic auth, CORS off by default, loopback bind, always-on CSRF guard, `PUT /roots` validation + lock |
| 2 | `slicerMetadata` is 96% of the list payload and 96% of the DB | **High** | Perf | **Fixed** — list responses use `LIST_QUERY` (no blob); `slicerMetadata` is detail-only |
| 3 | Viewer never disposes model geometry — GPU memory leaks per file opened | **High** | Bug | **Fixed** — `disposeObject3D` on model replace / unmount |
| 4 | A scan blocks the event loop and can run concurrently with itself | **High** | Bug/Perf | **Fixed** — mutex + `setImmediate` yield per file + opt-in `SCAN_WORKERS` pool; rich progress, cancel, and `reprocess-stale` resume |
| 5 | Each 3MF is opened and parsed ~7× per scan | Medium-High | Perf | **Fixed** — plate parse merged (`computePlateInfo`); dimensions + geometry hash now derived from the baked mesh (`scanArtifacts.ts`), so geometry is parsed once |
| 6 | Search fires one query per keystroke, with no ordering guard | Medium | Perf/Bug | **Fixed** — 250ms debounce + response sequence guard |
| 7 | `Detail.tsx` fetches race and have no error state | Medium | Bug | **Fixed** — cancellation guards + error view |
| 8 | An offline root flags its entire library "missing" | Medium | Bug | **Fixed** — `unavailableRootIds` skip |
| 9 | Symlinked / junctioned directories are silently skipped by the scanner | Medium | Bug | **Fixed** — `walk()` stats through symlinks, realpath cycle guard |
| 10 | No way to purge missing files; asset cache grows forever | Medium | Gap | **Fixed** — `DELETE /files/:id` + `POST /files/purge-missing` + startup `pruneOrphanAssets` + Missing view/section |
| 11 | Paint re-applies on every Detail re-render | Medium | Perf | **Fixed** — `filamentColors` memoized |
| 12 | "Name" sort is descending (Z→A) with no ascending toggle | Low-Med | UX | **Fixed** — `dir` param + per-column default + toggle |
| 13 | `preserveDrawingBuffer: true` with nothing reading pixels | Low | Perf | **Fixed** — removed |
| 14 | `resolveFilePath` prefix check, `sanitizeName` collisions, ASCII-STL size ceiling, `/archive-raw` double open | Low | Robustness | **Fixed** — boundary check, WebP name dedup, `solid`-prefix guard + oversize warning, `readArchiveModelEntry` opens the zip once |
| 15 | `synchronous=FULL`, no indexes beyond the two hash ones, `duplicate_count` per-row subquery | Low-Med | Perf | **Fixed** — `synchronous=NORMAL` + `foreign_keys=ON` + 7 indexes; `duplicate_count` is a materialized column refreshed at scan end / on delete |
| 16.1 | Print time / filament / cost from `slice_info.config` | — | Feature | **Built** — parsed, stored, Detail section + card badges + sort |

---

## 1. Security: the app is unauthenticated and CORS is wide open

**Severity: High. Measured.**

[`app.ts:25`](../server/src/app.ts#L25) is `app.use(cors())` — the default, which is
`Access-Control-Allow-Origin: *` for every route including the mutating ones. There is no
authentication anywhere in the API.

I verified this from a page on `http://localhost:5173` against the API on `:3001` (a genuine
cross-origin request):

- `GET http://localhost:3001/api/tags` → **200, body readable cross-origin**
- `PUT http://localhost:3001/api/settings` with a JSON body (so a real CORS preflight ran) →
  **200, write accepted**

So **any web page the user has open can read the entire catalogue and issue writes.** The
interesting targets:

- `PUT /api/roots` — a payload that omits a root **deletes that root's files, tags, notes and
  cached assets** ([`routes.ts:505-516`](../server/src/routes.ts#L505)). One drive-by request
  destroys the only irreplaceable data in the app.
- `PUT /api/roots` can also *add* a root pointing anywhere the server process can read
  (`C:\Users\...`, `/`), then `POST /api/scan`, then read files back out via `/api/raw/:id`.
  The scanner only catalogues `.stl/.3mf/.obj/.zip`, which bounds it — but it is still an
  arbitrary-file-read primitive scoped to those extensions.
- `DELETE /api/tags/:name`, `POST /api/files/bulk-tags` — silent data loss.

Compounding it: `docker-compose.yml` publishes `"3001:3001"`, which binds `0.0.0.0` on the
host. Anyone on the LAN gets the same API with no credential. `index.ts` likewise calls
`listen(PORT)` with no host argument.

**Recommendations, roughly in order of value per effort:**

1. Drop `cors()` in the production path entirely. The Docker image already serves the client
   from the same origin as the API ([`app.ts:29-38`](../server/src/app.ts#L29)), so CORS buys
   nothing there. In dev, Vite proxies `/api` ([`vite.config.ts`](../client/vite.config.ts)),
   which is also same-origin. CORS is only needed if someone runs the client on a different
   host — make that opt-in via an allowlist env var.
2. Default the listen host to `127.0.0.1`, with `HOST=0.0.0.0` as an explicit opt-in. Change
   the compose default to `127.0.0.1:3001:3001` and document putting a reverse proxy with auth
   in front for LAN use.
3. Add a shared-secret or basic-auth gate (single password in config, env-overridable) for
   anything non-GET, and ideally for GET too. This does not need to be sophisticated to close
   the drive-by case.
4. Consider a `PRINTSORT_READONLY=1` mode that rejects all mutations — useful for exposing the
   catalogue to a household without letting anyone reconfigure it.
5. Constrain `PUT /api/roots` to a configured allowlist of parent directories in container
   deployments (the managed-roots mechanism already models "the deployment owns the roots").

> Note: verifying this ran one real `PUT /api/settings` against your dev instance. It wrote
> `defaultPlateSize: {x:256, y:256}` — byte-identical to what was already stored, so nothing
> actually changed.

---

## 2. `slicerMetadata` dominates both the API payload and the database

**Severity: High. Measured.**

`serializeFile` returns `slicerMetadata` (the whole `project_settings.config` blob from a
Bambu/Orca 3MF) for **every row in every list response**
([`routes.ts:100`](../server/src/routes.ts#L100)), because `BASE_QUERY` is `SELECT f.*` and the
serializer is shared between the list and detail endpoints.

Measured on `GET /api/files?pageSize=20`:

```
payload            743,102 bytes
of which slicerMetadata   716,242 bytes   (96%)
worst single row      49,399 bytes   (whale-shark_Painted+Support.3mf)
request time          58-65 ms
```

And in the database:

```
catalog.db on disk           31,985,664 bytes
SUM(LENGTH(slicer_metadata_json))  30,793,795 bytes   (96%)
SUM(LENGTH(plates_json))              213,620 bytes
SUM(LENGTH(embedded_images_json))     144,841 bytes
```

The Library page never reads `slicerMetadata` — only
[`Detail.tsx:411-449`](../client/src/pages/Detail.tsx#L411) touches it, and only to render
three fields (filament type, filament colour, layer height) that are **already stored in their
own columns**.

So ~700 KB is parsed, serialised, transferred and re-parsed on every page of the Library, plus
every keystroke in the search box (see #6), to render nothing.

**Recommendations:**

1. Split the serializer: a `serializeFileSummary` for list responses that omits
   `slicerMetadata` (and probably `plates`, `embeddedImages`, `contentHash`, `geometryHash` —
   none are used by a card), and keep the full shape for `GET /api/files/:id`. Expect the list
   payload to drop from ~743 KB to ~27 KB.
2. Replace `SELECT f.*` in `BASE_QUERY` with an explicit column list for the list path so the
   30 MB blob column is never read off disk for a listing.
3. Longer term, question whether the raw blob needs to be in SQLite at all. It is only ever
   displayed as three extracted values. Storing it as a file under `ASSETS_DIR/<id>/` (or not
   at all) would shrink the catalogue by ~96% and make every query cheaper.

---

## 3. The viewer leaks GPU memory for every model opened

**Severity: High.**

[`ModelViewer.tsx:71-87`](../client/src/ModelViewer.tsx#L71) replaces `object` on every load and
drops the old `THREE.Group` on the floor. Three.js has no finalizer — a `BufferGeometry`'s GPU
buffers are only released by an explicit `.dispose()`. Nothing here disposes them, and the
cleanup function only flips a `cancelled` flag.

The pattern is clearly known in this file — `PrintBed` correctly disposes its edges geometry at
[`ModelViewer.tsx:215`](../client/src/ModelViewer.tsx#L215), and `removePaintColors` disposes
correctly at [`loadModel.ts:159`](../client/src/loadModel.ts#L159). The model itself is just
missed.

Practical impact: the baked mesh for a mid-size model is a few MB of vertex data. Browsing 30
files in a session (very normal for this app) accumulates all 30 in VRAM until the tab is
closed or the WebGL context is lost. On a laptop iGPU that is a real tab crash, not a
theoretical one.

**Fix:** in the load effect's cleanup, traverse the previous object and dispose every
`geometry` plus any material that isn't the shared `BAKED_GRAY` singleton:

```ts
const disposeObject = (o: THREE.Object3D) => {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mat = m.material;
    (Array.isArray(mat) ? mat : [mat]).forEach((x) => x !== BAKED_GRAY && x?.dispose());
  });
};
```

Careful with the shared module-level `BAKED_GRAY` material
([`loadModel.ts:42`](../client/src/loadModel.ts#L42)) — it is assigned to every mesh of every
model, so disposing it once breaks every model loaded afterwards for the life of the page.
Either exclude it explicitly (as above) or stop sharing it.

---

## 4. Scanning blocks the server, and two scans can run at once

**Severity: High.**

`runScan` is `async`, but almost everything it does is synchronous and CPU-bound on the main
thread:

- `walk()` — recursive `readdirSync` ([`scanner.ts:25`](../server/src/scanner.ts#L25))
- `computeDimensions`, `bakeModel`, `computeGeometryHash` — all `readFileSync` + tight parse
  loops
- `renderBakedThumbnail` — a full software rasteriser, `await`ed but the rasterising loop
  itself never yields ([`thumbnail.ts:187-209`](../server/src/thumbnail.ts#L187))

For the duration of a scan the API is effectively unresponsive. With 1,512 files and 32 GB of
geometry that is a long window, and `SCAN_ON_STARTUP=true` is set in the Docker image — so the
container's first minutes are exactly when the UI is least usable.

Separately, there is **no concurrency guard**. `POST /api/scan` can be fired repeatedly, and in
Docker the startup scan is already running when the first request arrives. Two concurrent
`runScan()` calls interleave their writes and their `seenFileIds` sets are independent, so the
missing-flag pass at [`scanner.ts:271-284`](../server/src/scanner.ts#L271) can mark files
missing that the *other* scan is in the middle of processing.

**Recommendations:**

1. A module-level scan mutex: if a scan is in flight, return `409` (or the in-progress state)
   rather than starting a second. Cheap, and closes the interleaving bug.
2. Move the per-file processing into a `worker_threads` pool. `bakeModel` +
   `renderBakedThumbnail` + hashing are pure functions over a file path — an ideal worker
   payload — and this is also the single biggest scan-throughput win available (parallel across
   cores instead of one core, serialised).
3. Failing that, `await new Promise(setImmediate)` between files so the event loop can serve
   requests. Much less effective, but a one-line mitigation.
4. Add scan progress reporting (SSE or a polled `GET /api/scan/status` with
   `processed/total/current file`) and a cancel. Right now a scan of this library is a spinner
   with no feedback for minutes — see #16.

---

## 5. Every 3MF is opened and fully parsed roughly seven times per scan

**Severity: Medium-High.**

For one `.3mf`, `processFile` ([`scanner.ts:150`](../server/src/scanner.ts#L150)) triggers:

| Call | What it does |
|---|---|
| `computeDimensions` | `new AdmZip(...)`, decompress every `.model`, regex every `<vertex>` |
| `bakeModel` | `new AdmZip(...)`, decompress every `.model`, full parse |
| `extractThreeMfData` | `new AdmZip(...)` |
| `cacheThreeMfImages` → `listThreeMfImages` | `new AdmZip(...)` |
| `computePlateBuildIndices` | `new AdmZip(...)` |
| `computePlateNames` | `new AdmZip(...)` (same file, same parse as the line above) |
| `computeGeometryHash` | `forEachVertex` **twice** — one counting pass, one filling pass — each a fresh `new AdmZip(...)` and full decompress |

That is seven archive opens and roughly four full geometry walks of the same bytes.
`AdmZip(filePath)` reads the entire archive into memory each time.

All of it is derivable from one parse:

- **Dimensions** are a bounding box over `bakedParts` — already computed by `computeBounds` in
  [`thumbnail.ts:53`](../server/src/thumbnail.ts#L53), on exactly the data `applyBakedMesh`
  already returns.
- **Geometry hash** needs the same vertex stream; feeding it `bakedParts` removes both of its
  passes and its zip opens.
- `computePlateBuildIndices` and `computePlateNames` parse the *same*
  `Metadata/model_settings.config` string with the *same* `parsePlateObjectIds` — they should
  share one call ([`threeMf.ts:238`](../server/src/threeMf.ts#L238) and
  [`threeMf.ts:279`](../server/src/threeMf.ts#L279)).
- `extractThreeMfData` and `listThreeMfImages` can share one `AdmZip` handle.

Realistic target: **one archive open and one geometry parse per file.** Given this is the app's
dominant cost, that is likely a 3–5× scan speedup before any parallelism.

Note the bake already stores world-space positions with transforms folded in, whereas
`computeDimensions` deliberately unions raw local vertices without transforms
([`docs/architecture.md`](architecture.md) line 62). Switching dimensions to the baked parts
would actually *fix* the inflated-bounding-box caveat documented there — but it changes results
for multi-component assemblies, so it needs a `CURRENT_SCANNER_VERSION` bump and a look at
`dimensions.test.ts`.

---

## 6. Search issues one request per keystroke, with no ordering guard

**Severity: Medium.**

[`Library.tsx:300`](../client/src/pages/Library.tsx#L300):

```tsx
onChange={(e) => updateParams({ q: e.target.value })}
```

That writes the URL, which the effect at [`Library.tsx:177`](../client/src/pages/Library.tsx#L177)
watches, which calls `load()`. Typing `dragon` fires six full list queries. Each currently
carries ~700 KB of unused metadata (#2) and runs `f.filename LIKE '%…%'` (unindexable, full
scan) plus the per-row `duplicate_count` correlated subquery.

There is also no cancellation or sequence guard in `loadInto()`
([`Library.tsx:153`](../client/src/pages/Library.tsx#L153)) — responses are applied in arrival
order, so a slow early request can land after a fast later one and leave the grid showing
results for a prefix of what is in the box.

**Fix:** debounce the `q` param update (~250 ms), and either use an `AbortController` per load
or stamp each request and ignore stale responses. Fixing #2 first makes each request ~27× smaller,
but the debounce is still worth having.

---

## 7. `Detail.tsx` fetches race and have no error path

**Severity: Medium.**

Two effects fetch without a cancellation guard:

- [`Detail.tsx:145-156`](../client/src/pages/Detail.tsx#L145) — `api.getFile(fileId)`
- [`Detail.tsx:177-184`](../client/src/pages/Detail.tsx#L177) — the raw-file `fetch`

Navigating from file A to file B while A is still loading lets A's response resolve second and
overwrite B's state — you get B's URL showing A's model or metadata. The nested `ArchiveViewer`
gets this right with a `cancelled` flag ([`Detail.tsx:75-87`](../client/src/pages/Detail.tsx#L75)),
so the fix is just applying the same pattern one level up.

Neither has a `.catch`. If `getFile` 404s or the server is down, the page renders
`Loading...` forever ([`Detail.tsx:218`](../client/src/pages/Detail.tsx#L218)) with no
indication anything failed. Same for a failed mesh fetch — `ModelViewer` catches and calls
`setObject(null)` ([`ModelViewer.tsx:83`](../client/src/ModelViewer.tsx#L83)), which renders an
empty viewer pane with no message.

The raw fetch also buffers the entire file into an `ArrayBuffer` in memory. The auto-threshold
caps that at 5 MB (`FULL_MODEL_AUTO_BYTES`), but the manual "Load full model" button has no cap
— clicking it on a 500 MB STL will do exactly what you'd expect.

---

## 8. An unreachable root flags its whole library as missing

**Severity: Medium.**

[`scanner.ts:214`](../server/src/scanner.ts#L214):

```ts
const files = fs.existsSync(root.path) ? walk(root.path) : [];
```

If a NAS is offline, a USB drive is unplugged, or a Docker mount hasn't come up yet, `files` is
empty, `seenFileIds` stays empty for that root, and the pass at
[`scanner.ts:271`](../server/src/scanner.ts#L271) marks **every file in that root** `missing = 1`.
Rows and tags survive (that's the documented design), but the entire library shows as missing
until the drive returns and a rescan runs.

With `SCAN_ON_STARTUP=true` in Docker, a container that starts before its NFS mount is ready
does this automatically on boot.

**Fix:** skip the missing-flag pass for any root whose path doesn't currently exist (or which
walked to zero files when it previously had many), and surface "source unavailable" in the UI
instead. A guard like "if the walk found 0 files but the root has >0 catalogued rows, treat the
root as unavailable rather than emptied" catches the unplugged-drive case cheaply.

---

## 9. Symlinked and junctioned directories are skipped silently

**Severity: Medium.**

[`scanner.ts:34`](../server/src/scanner.ts#L34) uses `entry.isDirectory()` on a `Dirent` from
`readdirSync(..., { withFileTypes: true })`. That does **not** follow symlinks — a symlink to a
directory reports `isSymbolicLink() === true` and `isDirectory() === false`, so it matches
neither branch and is dropped.

This matters for the target audience. Windows users commonly junction a models folder onto a
second drive; Linux/NAS users symlink shares into a single tree. Those subtrees are currently
invisible with no error, no warning, and nothing in the docs.

**Fix:** `statSync` (which follows) symlink entries and recurse when they resolve to a
directory. Add a visited-realpath set to avoid infinite recursion on a symlink cycle — that's
the reason to be deliberate about it rather than just flipping a flag.

---

## 10. Nothing ever purges missing files or orphaned assets

**Severity: Medium.**

`deleteCachedImages` is only called from `PUT /api/roots` when a whole root is removed
([`routes.ts:511`](../server/src/routes.ts#L511)). When an individual file is deleted from disk,
its row is flagged `missing = 1` and its `ASSETS_DIR/<id>/` directory — thumbnail, embedded
image WebPs, and the baked `mesh.bin.gz` — stays forever. There is no UI to remove a missing
file from the catalogue, and no prune command.

Over a year of reorganising a downloads folder, that's an unbounded pile of dead assets and
dead rows that still count toward `total` and still appear in listings.

**Recommendations:** a `DELETE /api/files/:id` (catalogue-only, never touches disk), a "Missing
files" view in Settings with a bulk-remove, and a startup prune of `ASSETS_DIR` subdirectories
with no corresponding `files` row.

---

## 11. Painted colours re-apply on every Detail re-render

**Severity: Medium.**

[`Detail.tsx:262`](../client/src/pages/Detail.tsx#L262) passes
`filamentColors={file.filaments.map((f) => f.color)}` — a **new array identity on every
render**. That array is a dependency of the paint effect at
[`ModelViewer.tsx:92-99`](../client/src/ModelViewer.tsx#L92), so the effect re-runs whenever
Detail re-renders for any reason: typing in the notes textarea, typing a tag, toggling a plate.

With "Show painted colors" on, each re-run calls `applyPaintColors`, which does
`geometry.toNonIndexed()` (a full geometry copy), allocates a `triCount * 9` colour array, and
constructs a new `MeshStandardMaterial` — per keystroke. It also leaves the previous painted
geometry undisposed, compounding #3.

**Fix:** `useMemo` the array in Detail keyed on `file.filaments`, or accept a stable
`filaments` object and derive colours inside `ModelViewer`.

---

## 12. "Name" sorts Z→A, and there's no direction toggle

**Severity: Low-Medium (UX).**

[`routes.ts:226`](../server/src/routes.ts#L226) hard-codes `ORDER BY ${sortCol} DESC`. That's
right for "Date added" and "Size", and wrong for "Name" — picking Name gives you a reverse
alphabetical library, which reads as a bug.

The table view also has no sortable column headers, so sorting is only reachable through the
toolbar `<select>`.

**Fix:** add a `dir` param (`asc`/`desc`, allowlisted the same way `sortCol` is), default it per
column (`name` → asc, everything else → desc), and add a direction toggle next to the sort
control. Clickable column headers in the table view are a natural follow-on.

---

## 13. `preserveDrawingBuffer: true` is dead weight

**Severity: Low.**

[`ModelViewer.tsx:316`](../client/src/ModelViewer.tsx#L316) sets
`gl={{ preserveDrawingBuffer: true }}`. That flag exists so the canvas can be read back after a
frame (`toDataURL` / `readPixels`) and forces the browser to retain the drawing buffer instead
of discarding it after each composite — a real per-frame memory and bandwidth cost, and on some
drivers it disables optimisations.

Nothing in the client reads pixels any more. `grep` for `toDataURL|toBlob|readPixels` across
`client/src` returns nothing — this is a leftover from the client-side `ThumbnailGenerator` that
was removed when thumbnails moved server-side.

**Fix:** delete the `gl` prop.

---

## 14. Robustness details

**`resolveFilePath` uses a prefix check, not a boundary check** —
[`routes.ts:595`](../server/src/routes.ts#L595):

```ts
if (!fullPath.startsWith(rootResolved)) return { error: 'invalid path' };
```

`startsWith` treats `/models/prints-backup/x.stl` as inside `/models/prints`. It's not
exploitable today (the path is always resolved against the file's *own* root, and
`relative_path` is scanner-produced, so escaping needs a `../` prefix that the scanner never
writes), but the guard exists precisely because that value is trusted-but-unvalidated DB data.
The correct form is:

```ts
if (fullPath !== rootResolved && !fullPath.startsWith(rootResolved + path.sep)) …
```

**`sanitizeName` collisions drop embedded images** —
[`assets.ts:29`](../server/src/assets.ts#L29) keys the cached WebP on the entry's *basename*.
Two entries at different paths inside a 3MF with the same basename (`Metadata/plate_1.png` and
`Metadata/sub/plate_1.png`) both map to `plate_1.webp`, and the second silently overwrites the
first. Hash or path-flatten the entry name instead.

**ASCII STL/OBJ over ~512 MB fail silently** —
[`geometryParse.ts:41`](../server/src/geometryParse.ts#L41) and friends call
`buffer.toString('utf-8')`. V8 caps strings at ~512 MB, so a large ASCII STL (routine for raw
3D-scan output) throws, gets swallowed by the `try/catch` at
[`geometryParse.ts:221`](../server/src/geometryParse.ts#L221), and the file silently ends up
with `null` dimensions and no geometry hash. Streaming line-wise, or at least logging the
failure, would make that diagnosable.

**Binary-STL detection falls through to garbage** — if
`84 + triangleCount * 50 !== buffer.length` (a truncated or padded binary STL), the code
reinterprets the binary bytes as UTF-8 text and regexes for `vertex`, which can match random
byte sequences and produce nonsense vertices rather than `null`.

**Archive entries are fully buffered** — `readArchiveEntry` calls `entry.getData()` and
`res.send(buffer)` ([`routes.ts:644`](../server/src/routes.ts#L644)). A zip entry declaring a
huge uncompressed size will be materialised in memory. Low risk for local files, but a size cap
would be cheap. `/api/files/:id/archive-raw` also opens and parses the whole zip **twice** per
request (once in `listArchiveModelEntries`, once in `readArchiveEntry`).

**`foreign_keys` relies on an undeclared default** — the schema declares
`ON DELETE CASCADE` on `file_tags`. SQLite disables FK enforcement by default; `node:sqlite`
happens to enable it (verified: `PRAGMA foreign_keys` → `1`), so the cascade does work today.
That's an implicit dependency on a library default for a correctness-relevant behaviour — worth
an explicit `PRAGMA foreign_keys = ON` next to the WAL pragma in
[`db.ts:9`](../server/src/db.ts#L9).

---

## 15. Database tuning

**Severity: Low-Medium.**

Measured on the live catalogue: `journal_mode = wal` (good), `synchronous = 2` (FULL).

With WAL, `synchronous = NORMAL` is the standard choice — it keeps crash-safety for the
database and only risks losing the last transaction or two on an OS-level crash, in exchange
for dropping an `fsync` per commit. `processFile` issues **six separate `UPDATE` statements per
file** ([`scanner.ts:150-168`](../server/src/scanner.ts#L150)), each its own implicit
transaction. Across 1,512 files that is ~9,000 fsyncs per full scan.

Two changes, both small:

1. `db.exec('PRAGMA synchronous = NORMAL')` alongside the WAL pragma.
2. Wrap each file's updates in one transaction — or better, collapse the six `UPDATE`s into one
   statement, since they all target the same row.

**Indexes.** The only non-automatic indexes are `idx_files_content_hash` and
`idx_files_geometry_hash`. There is nothing on `ext`, `filename`, `added_at`, `mtime`,
`size_bytes` or `root_id`, so every list query is a full scan plus a filesort. At 1,512 rows
that's the measured 58–65 ms and fine; it degrades linearly, and this is an app people point at
tens of thousands of files. Worth adding covering indexes for the sort columns before it bites.

**`duplicate_count` is a correlated subquery per row** —
[`routes.ts:152`](../server/src/routes.ts#L152) runs a `COUNT(*)` over `files` for every row
returned. The hash indexes make each cheap, but it is still N lookups per page, and it is also
computed on the count query's sibling path. `duplicatesOnly=1` measured 78–80 ms vs 58–65 ms for
a plain list.

---

## 16. Domain gaps and features worth adding

Ordered by what I'd expect to deliver the most value for a 3D-print file catalogue.

### 16.1 Print time, filament usage and cost — already in your files

Bambu Studio and OrcaSlicer write `Metadata/slice_info.config` into every sliced 3MF, containing
per-plate **prediction** (print time in seconds), **weight** (grams of filament), per-filament
usage, printer model, and support/nozzle settings. You are already opening these archives and
already have 807 3MFs — this is the highest-value metadata in the box and it is currently
ignored.

Surfacing "4h 22m · 68 g · PLA" on a card, and making it sortable and filterable, changes the
app from a file browser into a print-planning tool. Add a grams→cost setting and you get spool
cost per print for free.

### 16.2 Group companion files into one "model"

The single biggest structural gap. A typical Printables/MakerWorld download is a folder
containing `model.stl`, `model_v2.stl`, a sliced `model.3mf`, `README.txt`, and preview images.
Today those are three unrelated rows, and the folder is only a filter.

A first-class "model / project" entity — inferred from the containing folder, with the files as
its parts, tags and notes attached to the *model* rather than each file — matches how people
actually think about their library. It also makes the duplicate view far more useful (you'd
compare models, not incidental re-exports).

### 16.3 Source URL, designer and licence

Model libraries are legally load-bearing. Most downloads are CC-BY / CC-BY-NC and require
attribution if you print for others, and nothing in the app records where a file came from.
Add `sourceUrl`, `designer` and `license` fields (user-editable, like notes), and auto-populate
where possible — MakerWorld 3MFs often carry a design ID in their metadata, and many downloads
ship a `README`/`LICENSE` sidecar in the same folder.

### 16.4 Will it fit? — printability checks

You already compute `dimensions` and `bedSize` for every file. Two cheap, high-value derivations:

- Flag models whose bounding box exceeds the configured bed (X/Y **and** Z — currently the app
  parses `printable_area` but ignores `printable_height`, so max object height isn't captured).
  A "doesn't fit my printer" badge and filter is exactly what people want when browsing.
- Add a printer-profiles concept (bed X/Y/Z per printer) and filter by "fits on the A1 Mini".

### 16.5 Mesh health

The bake already walks every triangle, so this is nearly free at scan time:

- **Triangle count** — cheap, and the best proxy for "will this bog down my slicer".
- **Watertight / manifold check** — count edges used by exactly two triangles. Non-manifold or
  open meshes are the number-one cause of slicer failures, and flagging them at catalogue time
  is genuinely useful.
- **Flipped normals**, **degenerate triangles**, **multiple disconnected shells** (a "this STL
  contains 12 separate parts" hint).

### 16.6 Print history

A print log per model — date, printer, filament, outcome (success/failed/warped), notes, and
optionally a photo. This is the workflow layer that turns a catalogue into something used
weekly rather than at download time. It also gives "models I've actually printed" as a filter,
which is the query people ask most.

### 16.7 More formats

`.step`/`.stp` (functional/CAD parts — extremely common for printable mechanical designs),
`.gcode` and `.bgcode` (sliced-and-ready files; gcode headers carry print time and filament
estimates directly), `.ply`, `.amf`, `.svg` (for laser/vinyl workflows). Also `.7z`/`.rar`
alongside `.zip`, since Thingiverse and Cults bundles use them.

### 16.8 Search that reaches beyond the filename

`GET /api/files` only matches `f.filename LIKE '%q%'`. Notes and tags are not searched, and the
leading wildcard prevents any index use. SQLite's FTS5 is built in — an FTS table over
filename + relative path + notes + tags would be both faster and far more useful.

### 16.9 Duplicate resolution

The app finds duplicates well (measured: several files with 5 duplicates each) but you can't do
anything about them. A duplicates view that groups matches, shows sizes and paths side by side,
lets you pick a keeper and remove the rest from the catalogue — and optionally reports which
copies could be deleted from disk to reclaim space — closes the loop. With 32 GB catalogued
that's a concrete disk-space win.

### 16.10 Backup / portability of the irreplaceable data

Tags and notes are the only data in this app that can't be regenerated from the filesystem, and
they live in a single `catalog.db` with no export. Two complementary ideas:

- `GET /api/export` producing a JSON/CSV of `{relativePath, tags, notes, sourceUrl, …}`, plus a
  matching import.
- Optional **sidecar files** — a `.printsort.json` written next to each model (or one per
  folder). Tags survive a database loss, a move to another machine, and a change in root
  layout. For a library that lives on a NAS shared between machines this is close to essential.

### 16.11 Smaller wins

- **Scan progress and cancel** (see #4) — a spinner with no ETA over a 1,500-file library is
  the roughest edge in the current UI.
- **Thumbnails ignore filament colours.** `renderBakedThumbnail` always draws
  `BASE = 0x9a9a9a` ([`thumbnail.ts:24`](../server/src/thumbnail.ts#L24)) even though the baked
  parts carry per-triangle paint slots and the file carries the palette. Painting the thumbnail
  is a small change with a large visual payoff for AMS prints.
- **The 3D viewer ignores the light theme** — the canvas background is hard-coded `#15181c`
  ([`ModelViewer.tsx:319`](../client/src/ModelViewer.tsx#L319)). Deliberate and documented, but
  in light mode it's a large black rectangle in an otherwise light page. Worth revisiting.
- **Thumbnails aren't lazy-loaded** — `<img src>` with no `loading="lazy"` and no intrinsic
  dimensions ([`Library.tsx:401`](../client/src/pages/Library.tsx#L401)) means all 20 fetch at
  once and the grid shifts as they arrive.
- **`express.json({ limit: '25mb' })`** ([`app.ts:26`](../server/src/app.ts#L26)) was sized for
  the removed thumbnail-upload endpoint. No current route accepts a body anywhere near that;
  a few hundred KB would do.
- **No `Cache-Control` on assets.** Thumbnails, meshes and WebPs are served with Express's
  default ETag/Last-Modified only. They're content-addressed by file id and only change on
  rescan — a long `max-age` plus a cache-busting query param (e.g. the row's `mtime`) would
  eliminate a lot of revalidation round-trips on a 20-card grid.
- **No healthcheck or memory limit in `docker-compose.yml`**, and a large scan is exactly the
  kind of thing that will OOM a container without one.

---

## Suggested order of work

1. **#1 security** — smallest change, largest downside avoided. Restrict CORS, bind loopback by
   default, add a credential for non-loopback.
2. **#2 payload split** — a contained serializer change with a measured 96% payload reduction.
3. **#3 dispose + #13 drawing buffer + #11 memo** — three small client fixes that together stop
   the viewer leaking.
4. **#4 scan mutex** — a few lines, closes a real interleaving bug. Workers can follow.
5. **#6/#7 debounce and race guards** — small, and they're the bugs a user actually notices.
6. **#5 single-parse scan pipeline** — the big performance win, but it needs a
   `CURRENT_SCANNER_VERSION` bump and test changes, so it wants its own pass.
7. **#8/#9/#10 scanner correctness** — offline roots, symlinks, pruning.
8. Then features, starting with **16.1 (print time/filament — the data is already sitting in
   your files)** and **16.2 (model grouping)**.
