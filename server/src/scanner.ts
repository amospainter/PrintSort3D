import fs from 'fs';
import path from 'path';
import { db, RECOMPUTE_DUPLICATE_COUNTS_SQL } from './db';
import { loadConfig } from './config';
import { extractThreeMfData, groupImagesByPlate, computePlateInfo } from './threeMf';
import { extractSliceInfo } from './sliceInfo';
import { cacheThreeMfImages, cacheBakedMeshParts, saveThumbnail } from './assets';
import { computeDimensions } from './dimensions';
import { computeContentHash, computeGeometryHash } from './fingerprint';
import { listArchiveModelEntries } from './archive';
import { bakeModel, type BakedPart } from './meshBake';
import { renderBakedThumbnail } from './thumbnail';

const SUPPORTED_EXTS = new Set(['.stl', '.3mf', '.obj', '.zip']);

// Bumped whenever scan-time post-processing (dimensions, 3MF metadata/images, content/geometry
// hashing, archive entry counting, plate grouping, ...) changes in a way that existing rows
// should pick up. A row's `scanner_version` records which pass last processed it; on rescan, a
// row whose mtime hasn't changed still gets reprocessed if its scanner_version is behind, so
// backfilling a pre-existing catalog.db just needs a rescan rather than touching every file on
// disk. Legitimately-empty results (a file with no parseable geometry) still stop being
// reprocessed once caught up, unlike inferring "needs backfill" from a nullable column, which
// would retry forever for such files.
const CURRENT_SCANNER_VERSION = 11;

function walk(dir: string, fileList: string[] = [], seen: Set<string> = new Set()): string[] {
  // A symlink loop (or two symlinks pointing at a shared ancestor) would recurse forever —
  // track resolved directory paths and refuse to descend into one twice.
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return fileList;
  }
  if (seen.has(real)) return fileList;
  seen.add(real);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return fileList;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    // `withFileTypes` reports a symlink as neither dir nor file — stat through it so junctions
    // and symlinked folders (common on Windows and NAS setups) are still walked.
    if (entry.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue; // dangling link
      }
    }
    if (isDir) {
      walk(full, fileList, seen);
    } else if (isFile && SUPPORTED_EXTS.has(path.extname(entry.name).toLowerCase())) {
      fileList.push(full);
    }
  }
  return fileList;
}

function upsertRoot(rootPath: string, label: string): number {
  const existing = db.prepare('SELECT id FROM roots WHERE path = ?').get(rootPath) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE roots SET label = ? WHERE id = ?').run(label, existing.id);
    return existing.id;
  }
  const info = db.prepare('INSERT INTO roots (path, label) VALUES (?, ?)').run(rootPath, label);
  return info.lastInsertRowid as number;
}

export interface ScanResult {
  added: number;
  updated: number;
  missing: number;
}

function applyDimensions(fileId: number, fullPath: string, ext: string): void {
  const dims = computeDimensions(fullPath, ext);
  db.prepare('UPDATE files SET dimension_x = ?, dimension_y = ?, dimension_z = ? WHERE id = ?').run(
    dims?.x ?? null,
    dims?.y ?? null,
    dims?.z ?? null,
    fileId
  );
}

// Returns whether the 3MF carried its own embedded plate thumbnail (Bambu/Orca) — when it
// did, the scanner skips rendering a synthetic one over the top of it.
async function apply3mfMetadata(fileId: number, fullPath: string): Promise<boolean> {
  const extracted = extractThreeMfData(fullPath);
  let thumbPath: string | null = null;
  if (extracted.thumbnailBuffer) {
    thumbPath = saveThumbnail(fileId, extracted.thumbnailBuffer);
  }
  const embeddedImages = await cacheThreeMfImages(fileId, fullPath);
  const plates = groupImagesByPlate(embeddedImages);
  const { buildIndices: buildIndicesByPlate, names: namesByPlate } = computePlateInfo(fullPath);
  const sliceInfo = extractSliceInfo(fullPath);
  for (const plate of plates) {
    const indices = buildIndicesByPlate.get(plate.index);
    if (indices) plate.buildItemIndices = indices;
    const name = namesByPlate.get(plate.index);
    if (name) plate.name = name;
  }

  db.prepare(
    `UPDATE files SET thumbnail_path = ?, filament_type = ?, filament_color = ?, filaments_json = ?, layer_height = ?,
     slicer_metadata_json = ?, embedded_images_json = ?, plates_json = ?, plate_size_json = ?, slice_info_json = ?
     WHERE id = ?`
  ).run(
    thumbPath,
    extracted.filamentType,
    extracted.filamentColor,
    extracted.filaments.length > 0 ? JSON.stringify(extracted.filaments) : null,
    extracted.layerHeight,
    extracted.rawMetadata ? JSON.stringify(extracted.rawMetadata) : null,
    embeddedImages.length > 0 ? JSON.stringify(embeddedImages) : null,
    plates.length > 0 ? JSON.stringify(plates) : null,
    extracted.plateSize ? JSON.stringify(extracted.plateSize) : null,
    sliceInfo ? JSON.stringify(sliceInfo) : null,
    fileId
  );
  return thumbPath !== null;
}

// Bakes STL/OBJ/3MF into a ready-to-render binary mesh cached under ASSETS_DIR so the viewer
// skips unzipping + DOM-parsing the source file in the browser. `mesh_path` is the cached
// filename, or NULL when the bake found no geometry (viewer falls back to the raw file).
// Returns the baked parts so the caller can also feed them to the thumbnail renderer
// without parsing the source file a second time.
function applyBakedMesh(fileId: number, fullPath: string, ext: string): BakedPart[] | null {
  let parts: BakedPart[] | null;
  try {
    parts = bakeModel(fullPath, ext);
  } catch {
    parts = null; // one unparseable model must not abort the scan
  }
  const meshPath = parts && parts.length > 0 ? cacheBakedMeshParts(fileId, parts) : null;
  db.prepare('UPDATE files SET mesh_path = ? WHERE id = ?').run(meshPath, fileId);
  return parts && parts.length > 0 ? parts : null;
}

// Renders a CPU-rasterized thumbnail (no GPU / WebGL — the server is often headless in
// Docker) from the already-baked mesh and caches it at ASSETS_DIR/<id>/thumbnail.png.
// Skipped when the file already supplied its own thumbnail (a Bambu 3MF's embedded plate
// image, handled in apply3mfMetadata).
async function applyRenderedThumbnail(fileId: number, parts: BakedPart[]): Promise<void> {
  const png = await renderBakedThumbnail(parts);
  if (!png) return;
  const stored = saveThumbnail(fileId, png);
  db.prepare('UPDATE files SET thumbnail_path = ? WHERE id = ?').run(stored, fileId);
}

function applyArchiveMetadata(fileId: number, fullPath: string): void {
  const entries = listArchiveModelEntries(fullPath);
  db.prepare('UPDATE files SET archive_entry_count = ? WHERE id = ?').run(entries.length, fileId);
}

async function applyFingerprint(fileId: number, fullPath: string, ext: string): Promise<void> {
  const contentHash = await computeContentHash(fullPath);
  const geometryHash = computeGeometryHash(fullPath, ext);
  db.prepare('UPDATE files SET content_hash = ?, geometry_hash = ? WHERE id = ?').run(
    contentHash,
    geometryHash,
    fileId
  );
}

async function processFile(fileId: number, fullPath: string, ext: string): Promise<void> {
  applyDimensions(fileId, fullPath, ext);
  let bakedParts: BakedPart[] | null = null;
  if (ext === '.stl' || ext === '.obj' || ext === '.3mf') {
    bakedParts = applyBakedMesh(fileId, fullPath, ext);
  }
  let hasEmbeddedThumbnail = false;
  if (ext === '.3mf') {
    hasEmbeddedThumbnail = await apply3mfMetadata(fileId, fullPath);
  }
  if (ext === '.zip') {
    applyArchiveMetadata(fileId, fullPath);
  }
  if (bakedParts && !hasEmbeddedThumbnail) {
    await applyRenderedThumbnail(fileId, bakedParts);
  }
  await applyFingerprint(fileId, fullPath, ext);
  db.prepare('UPDATE files SET scanner_version = ? WHERE id = ?').run(CURRENT_SCANNER_VERSION, fileId);
}

// Materialized-column maintenance for `files.duplicate_count`. Cheap even for a large catalog
// (the hash indexes make each correlated count O(log n + matches)), and it only runs at the
// end of a scan and on delete/purge — never per request.
export function recomputeDuplicateCounts(): void {
  db.exec(RECOMPUTE_DUPLICATE_COUNTS_SQL);
}

export type RescanStatus = 'ok' | 'missing' | 'not_found';

// Forces one file through processFile() regardless of scanner_version/mtime — a manual
// "rescan this one" action for fast iteration while developing/testing scan-time logic,
// as opposed to runScan()'s catalog-wide pass which only reprocesses what's changed or
// behind CURRENT_SCANNER_VERSION.
export async function rescanFile(fileId: number): Promise<RescanStatus> {
  const row = db
    .prepare(
      'SELECT f.relative_path as relative_path, r.path as root_path FROM files f JOIN roots r ON r.id = f.root_id WHERE f.id = ?'
    )
    .get(fileId) as { relative_path: string; root_path: string } | undefined;
  if (!row) return 'not_found';

  const fullPath = path.join(row.root_path, row.relative_path);
  if (!fs.existsSync(fullPath)) {
    db.prepare('UPDATE files SET missing = 1 WHERE id = ?').run(fileId);
    return 'missing';
  }

  const stat = fs.statSync(fullPath);
  const ext = path.extname(fullPath).toLowerCase();
  const mtime = Math.floor(stat.mtimeMs);
  db.prepare('UPDATE files SET size_bytes = ?, mtime = ?, missing = 0 WHERE id = ?').run(stat.size, mtime, fileId);

  await processFile(fileId, fullPath, ext);
  recomputeDuplicateCounts(); // this file's hashes may have changed, shifting others' counts
  return 'ok';
}

// Only one scan runs at a time. Two concurrent runScan() calls would interleave their writes
// and, worse, each has its own `seenFileIds` set — so one could flag a file `missing` that the
// other is mid-way through processing. Callers that fire a scan while one is running get the
// in-flight scan's result instead of starting a second. (`SCAN_ON_STARTUP` + an eager user
// clicking Rescan is the common way to hit this.)
let inFlightScan: Promise<ScanResult> | null = null;

export function isScanning(): boolean {
  return inFlightScan !== null;
}

export function runScan(options: { rootLabel?: string } = {}): Promise<ScanResult> {
  if (inFlightScan) return inFlightScan;
  inFlightScan = doScan(options).finally(() => {
    inFlightScan = null;
  });
  return inFlightScan;
}

// `rootLabel` scopes the scan to a single watched folder (matched by its config label) —
// the per-source "rescan this folder" action. The walk, the new/changed detection, and the
// missing-flag pass at the end are all scoped to `scanRoots`, so a per-folder scan never
// touches rows belonging to other roots. Omit it for the catalog-wide pass.
async function doScan(options: { rootLabel?: string } = {}): Promise<ScanResult> {
  const config = loadConfig();
  const scanRoots =
    options.rootLabel != null
      ? config.roots.filter((r) => r.label === options.rootLabel)
      : config.roots;
  const result: ScanResult = { added: 0, updated: 0, missing: 0 };
  const seenFileIds = new Set<number>();
  // Roots whose path is currently unreachable (unplugged drive, offline NAS, Docker mount not
  // yet up). Their catalogued rows are left exactly as they are — flagging a whole library
  // `missing` because a drive is temporarily absent, then un-flagging on the next scan, is
  // worse than a brief staleness. A root that walked to zero files but has >0 catalogued rows
  // is treated the same way (almost always an unmounted share, not a real bulk deletion).
  const unavailableRootIds = new Set<number>();

  for (const root of scanRoots) {
    const rootId = upsertRoot(root.path, root.label);
    const exists = fs.existsSync(root.path);
    const files = exists ? walk(root.path) : [];

    if (!exists) {
      unavailableRootIds.add(rootId);
    } else if (files.length === 0) {
      const rowCount = (
        db.prepare('SELECT COUNT(*) as c FROM files WHERE root_id = ?').get(rootId) as { c: number }
      ).c;
      if (rowCount > 0) unavailableRootIds.add(rootId);
    }

    for (const fullPath of files) {
      try {
        const relativePath = path.relative(root.path, fullPath);
        const stat = fs.statSync(fullPath);
        const ext = path.extname(fullPath).toLowerCase();
        const filename = path.basename(fullPath);
        const mtime = Math.floor(stat.mtimeMs);

        const existing = db
          .prepare('SELECT id, mtime, scanner_version FROM files WHERE root_id = ? AND relative_path = ?')
          .get(rootId, relativePath) as { id: number; mtime: number; scanner_version: number } | undefined;

        if (existing) {
          // Recorded as seen before any risky parsing below, so a corrupt file that throws
          // partway through doesn't also get wrongly flagged `missing` by the pass at the
          // end of this function.
          seenFileIds.add(existing.id);
          const mtimeChanged = existing.mtime !== mtime;
          const needsBackfill = existing.scanner_version < CURRENT_SCANNER_VERSION;

          if (mtimeChanged) {
            db.prepare('UPDATE files SET size_bytes = ?, mtime = ?, missing = 0 WHERE id = ?').run(
              stat.size,
              mtime,
              existing.id
            );
          } else {
            db.prepare('UPDATE files SET missing = 0 WHERE id = ?').run(existing.id);
          }

          if (mtimeChanged || needsBackfill) {
            await processFile(existing.id, fullPath, ext);
            result.updated++;
          }
        } else {
          const info = db
            .prepare(
              `INSERT INTO files (root_id, relative_path, filename, ext, size_bytes, mtime, added_at, thumbnail_path, missing)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`
            )
            .run(rootId, relativePath, filename, ext, stat.size, mtime, Date.now());
          const fileId = info.lastInsertRowid as number;
          seenFileIds.add(fileId);
          result.added++;

          await processFile(fileId, fullPath, ext);
        }
      } catch (err) {
        // A single corrupt/unreadable file (bad zip CRC, truncated STL, permissions error,
        // etc.) shouldn't abort the scan for every other file in the folder — log and move on.
        console.error(`Scan: failed to process ${fullPath}:`, err);
      }
    }
  }

  // Mark files not seen in this scan as missing — but only within roots that were actually
  // reachable this pass (see `unavailableRootIds`).
  const rootIds = scanRoots
    .map((r) => upsertRoot(r.path, r.label))
    .filter((id) => !unavailableRootIds.has(id));
  if (rootIds.length > 0) {
    const placeholders = rootIds.map(() => '?').join(',');
    const allFiles = db
      .prepare(`SELECT id FROM files WHERE root_id IN (${placeholders})`)
      .all(...rootIds) as { id: number }[];
    for (const f of allFiles) {
      if (!seenFileIds.has(f.id)) {
        db.prepare('UPDATE files SET missing = 1 WHERE id = ?').run(f.id);
        result.missing++;
      }
    }
  }

  // Refresh the materialized duplicate counts once, now that every new/changed file has its
  // hashes. (Adding one file can change another's count, so this is whole-table.)
  recomputeDuplicateCounts();

  return result;
}
