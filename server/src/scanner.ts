import fs from 'fs';
import path from 'path';
import { db } from './db';
import { loadConfig } from './config';
import { extractThreeMfData, groupImagesByPlate, computePlateBuildIndices, computePlateNames } from './threeMf';
import { cacheThreeMfImages, cacheBakedMesh, saveThumbnail } from './assets';
import { computeDimensions } from './dimensions';
import { computeContentHash, computeGeometryHash } from './fingerprint';
import { listArchiveModelEntries } from './archive';

const SUPPORTED_EXTS = new Set(['.stl', '.3mf', '.obj', '.zip']);

// Bumped whenever scan-time post-processing (dimensions, 3MF metadata/images, content/geometry
// hashing, archive entry counting, plate grouping, ...) changes in a way that existing rows
// should pick up. A row's `scanner_version` records which pass last processed it; on rescan, a
// row whose mtime hasn't changed still gets reprocessed if its scanner_version is behind, so
// backfilling a pre-existing catalog.db just needs a rescan rather than touching every file on
// disk. Legitimately-empty results (a file with no parseable geometry) still stop being
// reprocessed once caught up, unlike inferring "needs backfill" from a nullable column, which
// would retry forever for such files.
const CURRENT_SCANNER_VERSION = 9;

function walk(dir: string, fileList: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return fileList;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, fileList);
    } else if (SUPPORTED_EXTS.has(path.extname(entry.name).toLowerCase())) {
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

async function apply3mfMetadata(fileId: number, fullPath: string): Promise<void> {
  const extracted = extractThreeMfData(fullPath);
  let thumbPath: string | null = null;
  if (extracted.thumbnailBuffer) {
    thumbPath = saveThumbnail(fileId, extracted.thumbnailBuffer);
  }
  const embeddedImages = await cacheThreeMfImages(fileId, fullPath);
  const plates = groupImagesByPlate(embeddedImages);
  const buildIndicesByPlate = computePlateBuildIndices(fullPath);
  const namesByPlate = computePlateNames(fullPath);
  for (const plate of plates) {
    const indices = buildIndicesByPlate.get(plate.index);
    if (indices) plate.buildItemIndices = indices;
    const name = namesByPlate.get(plate.index);
    if (name) plate.name = name;
  }

  db.prepare(
    `UPDATE files SET thumbnail_path = ?, filament_type = ?, filament_color = ?, filaments_json = ?, layer_height = ?,
     slicer_metadata_json = ?, embedded_images_json = ?, plates_json = ?, plate_size_json = ?
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
    fileId
  );
}

// Bakes STL/OBJ/3MF into a ready-to-render binary mesh cached under ASSETS_DIR so the viewer
// skips unzipping + DOM-parsing the source file in the browser. `mesh_path` is the cached
// filename, or NULL when the bake found no geometry (viewer falls back to the raw file).
function applyBakedMesh(fileId: number, fullPath: string, ext: string): void {
  const meshPath = cacheBakedMesh(fileId, fullPath, ext);
  db.prepare('UPDATE files SET mesh_path = ? WHERE id = ?').run(meshPath, fileId);
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
  if (ext === '.stl' || ext === '.obj' || ext === '.3mf') {
    applyBakedMesh(fileId, fullPath, ext);
  }
  if (ext === '.3mf') {
    await apply3mfMetadata(fileId, fullPath);
  }
  if (ext === '.zip') {
    applyArchiveMetadata(fileId, fullPath);
  }
  await applyFingerprint(fileId, fullPath, ext);
  db.prepare('UPDATE files SET scanner_version = ? WHERE id = ?').run(CURRENT_SCANNER_VERSION, fileId);
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
  return 'ok';
}

// `rootLabel` scopes the scan to a single watched folder (matched by its config label) —
// the per-source "rescan this folder" action. The walk, the new/changed detection, and the
// missing-flag pass at the end are all scoped to `scanRoots`, so a per-folder scan never
// touches rows belonging to other roots. Omit it for the catalog-wide pass.
export async function runScan(options: { rootLabel?: string } = {}): Promise<ScanResult> {
  const config = loadConfig();
  const scanRoots =
    options.rootLabel != null
      ? config.roots.filter((r) => r.label === options.rootLabel)
      : config.roots;
  const result: ScanResult = { added: 0, updated: 0, missing: 0 };
  const seenFileIds = new Set<number>();

  for (const root of scanRoots) {
    const rootId = upsertRoot(root.path, root.label);
    const files = fs.existsSync(root.path) ? walk(root.path) : [];

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

  // Mark files not seen in this scan as missing (only within scanned roots)
  const rootIds = scanRoots.map((r) => upsertRoot(r.path, r.label));
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

  return result;
}
