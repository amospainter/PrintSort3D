import fs from 'fs';
import path from 'path';
import { db, RECOMPUTE_DUPLICATE_COUNTS_SQL, RECOMPUTE_DUPLICATE_COUNTS_SCOPED_SQL } from './db';
import { loadConfig } from './config';
import { THUMBNAIL_FILENAME } from './assets';
import { extractArtifactsPooled } from './scanPool';
import { statFile, type FileArtifacts } from './scanArtifacts';

const SUPPORTED_EXTS = new Set(['.stl', '.3mf', '.obj', '.zip', '.f3d']);

// Bumped whenever scan-time post-processing (dimensions, 3MF metadata/images, content/geometry
// hashing, archive entry counting, plate grouping, ...) changes in a way that existing rows
// should pick up. A row's `scanner_version` records which pass last processed it; on rescan, a
// row whose mtime hasn't changed still gets reprocessed if its scanner_version is behind, so
// backfilling a pre-existing catalog.db just needs a rescan rather than touching every file on
// disk. Legitimately-empty results (a file with no parseable geometry) still stop being
// reprocessed once caught up, unlike inferring "needs backfill" from a nullable column, which
// would retry forever for such files.
const CURRENT_SCANNER_VERSION = 12;

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
  cancelled: boolean;
}

// ─── DB write half ──────────────────────────────────────────────────────────────────────
// Everything the extract step computed (scanArtifacts.ts) collapsed into at most two UPDATEs
// per file (was six). The extract step already wrote the derived files under ASSETS_DIR.

function writeArtifacts(fileId: number, a: FileArtifacts): void {
  db.prepare(
    `UPDATE files SET
       dimension_x = ?, dimension_y = ?, dimension_z = ?,
       mesh_path = ?,
       content_hash = ?, geometry_hash = ?,
       thumbnail_path = ?,
       archive_entry_count = ?,
       scanner_version = ?
     WHERE id = ?`
  ).run(
    a.dimensions?.x ?? null,
    a.dimensions?.y ?? null,
    a.dimensions?.z ?? null,
    a.meshCached ? 'mesh.bin.gz' : null,
    a.contentHash,
    a.geometryHash,
    a.thumbnailWritten ? THUMBNAIL_FILENAME : null,
    a.archiveEntryCount,
    CURRENT_SCANNER_VERSION,
    fileId
  );

  if (a.threeMf) {
    const tm = a.threeMf;
    db.prepare(
      `UPDATE files SET
         filament_type = ?, filament_color = ?, filaments_json = ?, layer_height = ?,
         slicer_metadata_json = ?, embedded_images_json = ?, plates_json = ?,
         plate_size_json = ?, slice_info_json = ?
       WHERE id = ?`
    ).run(
      tm.filamentType,
      tm.filamentColor,
      tm.filamentsJson,
      tm.layerHeight,
      tm.slicerMetadataJson,
      tm.embeddedImagesJson,
      tm.platesJson,
      tm.plateSizeJson,
      tm.sliceInfoJson,
      fileId
    );
  }
}

// The content/geometry hashes touched during a scan — every value a changed file *had*
// (before reprocessing) and *has* (after). Only files whose hash is in here can have a stale
// `duplicate_count`, so the end-of-scan recompute is scoped to these rather than the whole table.
export interface TouchedHashes {
  content: Set<string>;
  geometry: Set<string>;
}

export function newTouchedHashes(): TouchedHashes {
  return { content: new Set(), geometry: new Set() };
}

function noteHashes(row: { content_hash?: string | null; geometry_hash?: string | null } | undefined, into: TouchedHashes): void {
  if (row?.content_hash) into.content.add(row.content_hash);
  if (row?.geometry_hash) into.geometry.add(row.geometry_hash);
}

async function processFile(
  fileId: number,
  fullPath: string,
  ext: string,
  touched?: TouchedHashes
): Promise<void> {
  if (touched) {
    noteHashes(
      db.prepare('SELECT content_hash, geometry_hash FROM files WHERE id = ?').get(fileId) as
        | { content_hash: string | null; geometry_hash: string | null }
        | undefined,
      touched
    );
  }
  const artifacts = await extractArtifactsPooled(fileId, fullPath, ext);
  writeArtifacts(fileId, artifacts);
  if (touched) {
    if (artifacts.contentHash) touched.content.add(artifacts.contentHash);
    if (artifacts.geometryHash) touched.geometry.add(artifacts.geometryHash);
  }
}

// Materialized-column maintenance for `files.duplicate_count`. The hash indexes make each
// correlated count O(log n + matches); this still only runs at the end of a scan and on
// delete/purge — never per request.
export function recomputeDuplicateCounts(): void {
  db.exec(RECOMPUTE_DUPLICATE_COUNTS_SQL);
}

// Scoped recompute: just the files sharing a hash with something the scan (or a delete)
// touched. Falls back to the whole-table pass when so many hashes were touched that scoping
// buys nothing (a full backfill / large reprocess).
export function recomputeDuplicateCountsFor(touched: TouchedHashes): void {
  const total = touched.content.size + touched.geometry.size;
  if (total === 0) return;
  if (total > 1500) {
    recomputeDuplicateCounts();
    return;
  }
  db.prepare(RECOMPUTE_DUPLICATE_COUNTS_SCOPED_SQL).run(
    JSON.stringify([...touched.content]),
    JSON.stringify([...touched.geometry])
  );
}

// Count of rows that a plain rescan would reprocess (behind on scan-time processing). The UI
// shows this after a scanner bump as "N files need a metadata update".
export function pendingReprocessCount(): number {
  return (
    db
      .prepare('SELECT COUNT(*) as c FROM files WHERE missing = 0 AND scanner_version < ?')
      .get(CURRENT_SCANNER_VERSION) as { c: number }
  ).c;
}

export type RescanStatus = 'ok' | 'missing' | 'not_found';

// Forces one file through processFile() regardless of scanner_version/mtime — the per-file
// "rescan this one" action.
export async function rescanFile(fileId: number): Promise<RescanStatus> {
  const row = db
    .prepare(
      'SELECT f.relative_path as relative_path, r.path as root_path FROM files f JOIN roots r ON r.id = f.root_id WHERE f.id = ?'
    )
    .get(fileId) as { relative_path: string; root_path: string } | undefined;
  if (!row) return 'not_found';

  const fullPath = path.join(row.root_path, row.relative_path);
  const st = statFile(fullPath);
  if (!st) {
    db.prepare('UPDATE files SET missing = 1 WHERE id = ?').run(fileId);
    return 'missing';
  }

  const ext = path.extname(fullPath).toLowerCase();
  db.prepare('UPDATE files SET size_bytes = ?, mtime = ?, missing = 0 WHERE id = ?').run(
    st.size,
    Math.floor(st.mtimeMs),
    fileId
  );

  const touched = newTouchedHashes();
  await processFile(fileId, fullPath, ext, touched);
  recomputeDuplicateCountsFor(touched); // this file's hashes may have shifted others' counts
  return 'ok';
}

// ─── Scan job state ─────────────────────────────────────────────────────────────────────

export type ScanPhase =
  | 'idle'
  | 'walking'
  | 'processing'
  | 'flagging-missing'
  | 'finalizing'
  | 'done'
  | 'cancelled'
  | 'error';
export type ScanMode = 'scan' | 'reprocess-stale' | 'reprocess-all';

export interface ScanProgress {
  running: boolean;
  phase: ScanPhase;
  mode: ScanMode;
  rootLabel: string | null;
  total: number; // files this pass will process (known once walking/enumeration is done)
  processed: number;
  added: number;
  updated: number;
  missing: number;
  currentFile: string | null; // relative_path of the file being processed
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

function idleProgress(): ScanProgress {
  return {
    running: false,
    phase: 'idle',
    mode: 'scan',
    rootLabel: null,
    total: 0,
    processed: 0,
    added: 0,
    updated: 0,
    missing: 0,
    currentFile: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

let progress: ScanProgress = idleProgress();
let cancelRequested = false;
let inFlightScan: Promise<ScanResult> | null = null;

export function isScanning(): boolean {
  return inFlightScan !== null;
}

export function getScanProgress(): ScanProgress {
  return { ...progress };
}

/** Ask the running scan to stop after the current file. No-op if nothing is running. */
export function requestScanCancel(): void {
  if (inFlightScan) cancelRequested = true;
}

interface ScanOptions {
  rootLabel?: string;
  mode?: ScanMode;
}

export function runScan(options: ScanOptions = {}): Promise<ScanResult> {
  if (inFlightScan) return inFlightScan;
  cancelRequested = false;
  progress = {
    ...idleProgress(),
    running: true,
    phase: 'walking',
    mode: options.mode ?? 'scan',
    rootLabel: options.rootLabel ?? null,
    startedAt: Date.now(),
  };
  inFlightScan = doScan(options)
    .then((r) => {
      progress = {
        ...progress,
        running: false,
        phase: r.cancelled ? 'cancelled' : 'done',
        finishedAt: Date.now(),
        currentFile: null,
      };
      return r;
    })
    .catch((err) => {
      progress = {
        ...progress,
        running: false,
        phase: 'error',
        finishedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
      throw err;
    })
    .finally(() => {
      inFlightScan = null;
    });
  return inFlightScan;
}

// ─── The scan itself ────────────────────────────────────────────────────────────────────

async function doScan(options: ScanOptions): Promise<ScanResult> {
  const mode = options.mode ?? 'scan';
  return mode === 'scan' ? walkScan(options.rootLabel) : reprocessScan(mode, options.rootLabel);
}

// A plain "look at the filesystem" scan: walk each root, add new files, reprocess changed or
// version-behind rows, flag files gone from disk as missing.
async function walkScan(rootLabel: string | undefined): Promise<ScanResult> {
  const config = loadConfig();
  const scanRoots =
    rootLabel != null ? config.roots.filter((r) => r.label === rootLabel) : config.roots;
  const result: ScanResult = { added: 0, updated: 0, missing: 0, cancelled: false };
  const seenFileIds = new Set<number>();
  const touched = newTouchedHashes();
  // Roots whose path is currently unreachable (unplugged drive, offline NAS, Docker mount not
  // yet up). Their catalogued rows are left exactly as they are — flagging a whole library
  // `missing` because a drive is temporarily absent, then un-flagging on the next scan, is
  // worse than a brief staleness. A root that walked to zero files but has >0 catalogued rows
  // is treated the same way (almost always an unmounted share, not a real bulk deletion).
  const unavailableRootIds = new Set<number>();

  // Enumerate everything first so `progress.total` is meaningful.
  const walked: { rootId: number; rootPath: string; files: string[] }[] = [];
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
    walked.push({ rootId, rootPath: root.path, files });
  }

  progress = {
    ...progress,
    phase: 'processing',
    total: walked.reduce((n, w) => n + w.files.length, 0),
  };

  for (const { rootId, rootPath, files } of walked) {
    for (const fullPath of files) {
      if (cancelRequested) {
        result.cancelled = true;
        break;
      }
      const relativePath = path.relative(rootPath, fullPath);
      progress = { ...progress, currentFile: relativePath, processed: progress.processed + 1 };
      try {
        const st = statFile(fullPath);
        if (!st) continue;
        const ext = path.extname(fullPath).toLowerCase();
        const filename = path.basename(fullPath);
        const mtime = Math.floor(st.mtimeMs);

        const existing = db
          .prepare('SELECT id, mtime, scanner_version FROM files WHERE root_id = ? AND relative_path = ?')
          .get(rootId, relativePath) as { id: number; mtime: number; scanner_version: number } | undefined;

        if (existing) {
          // Recorded as seen before any risky parsing below, so a corrupt file that throws
          // partway through doesn't also get wrongly flagged `missing` by the pass at the end.
          seenFileIds.add(existing.id);
          const mtimeChanged = existing.mtime !== mtime;
          const needsBackfill = existing.scanner_version < CURRENT_SCANNER_VERSION;

          if (mtimeChanged) {
            db.prepare('UPDATE files SET size_bytes = ?, mtime = ?, missing = 0 WHERE id = ?').run(
              st.size,
              mtime,
              existing.id
            );
          } else {
            db.prepare('UPDATE files SET missing = 0 WHERE id = ?').run(existing.id);
          }

          if (mtimeChanged || needsBackfill) {
            await processFile(existing.id, fullPath, ext, touched);
            result.updated++;
            progress = { ...progress, updated: result.updated };
          }
        } else {
          const info = db
            .prepare(
              `INSERT INTO files (root_id, relative_path, filename, ext, size_bytes, mtime, added_at, thumbnail_path, missing)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`
            )
            .run(rootId, relativePath, filename, ext, st.size, mtime, Date.now());
          const fileId = info.lastInsertRowid as number;
          seenFileIds.add(fileId);
          result.added++;
          progress = { ...progress, added: result.added };

          await processFile(fileId, fullPath, ext, touched);
        }
      } catch (err) {
        // A single corrupt/unreadable file shouldn't abort the scan for every other file.
        console.error(`Scan: failed to process ${fullPath}:`, err);
      }
      await yieldToLoop();
    }
    if (result.cancelled) break;
  }

  if (!result.cancelled) {
    // Mark files not seen in this scan as missing — but only within roots that were actually
    // reachable this pass (see `unavailableRootIds`). A cancelled scan skips this entirely:
    // it never finished looking, so it can't conclude anything is gone.
    progress = { ...progress, phase: 'flagging-missing', currentFile: null };
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
    progress = { ...progress, missing: result.missing };
  }

  progress = { ...progress, phase: 'finalizing', currentFile: null };
  recomputeDuplicateCountsFor(touched);
  return result;
}

// A "reprocess" pass: no filesystem walk and no missing-flag pass. Re-runs the extract/write
// step over existing rows — 'reprocess-stale' for rows behind on scanner_version (the "resume
// an interrupted scan" / "backfill after a version bump" case), 'reprocess-all' for every
// non-missing row.
async function reprocessScan(
  mode: 'reprocess-stale' | 'reprocess-all',
  rootLabel: string | undefined
): Promise<ScanResult> {
  const result: ScanResult = { added: 0, updated: 0, missing: 0, cancelled: false };

  const clauses = ['f.missing = 0'];
  const params: (string | number)[] = [];
  if (mode === 'reprocess-stale') {
    clauses.push('f.scanner_version < ?');
    params.push(CURRENT_SCANNER_VERSION);
  }
  if (rootLabel != null) {
    clauses.push('r.label = ?');
    params.push(rootLabel);
  }

  const rows = db
    .prepare(
      `SELECT f.id, f.relative_path as rel, f.ext as ext, r.path as rootPath
       FROM files f JOIN roots r ON r.id = f.root_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY f.id`
    )
    .all(...params) as { id: number; rel: string; ext: string; rootPath: string }[];

  progress = { ...progress, phase: 'processing', total: rows.length };
  const touched = newTouchedHashes();

  for (const row of rows) {
    if (cancelRequested) {
      result.cancelled = true;
      break;
    }
    progress = { ...progress, currentFile: row.rel, processed: progress.processed + 1 };
    const fullPath = path.join(row.rootPath, row.rel);
    try {
      const st = statFile(fullPath);
      if (!st) {
        // Gone from disk since the last walk — flag it, don't reprocess.
        db.prepare('UPDATE files SET missing = 1 WHERE id = ?').run(row.id);
        result.missing++;
        progress = { ...progress, missing: result.missing };
        continue;
      }
      await processFile(row.id, fullPath, row.ext.toLowerCase(), touched);
      result.updated++;
      progress = { ...progress, updated: result.updated };
    } catch (err) {
      console.error(`Reprocess: failed on ${fullPath}:`, err);
    }
    await yieldToLoop();
  }

  progress = { ...progress, phase: 'finalizing', currentFile: null };
  recomputeDuplicateCountsFor(touched);
  return result;
}

// Hand the event loop a turn between files so the API stays responsive during a long scan
// even without the worker pool (inline processing otherwise monopolises the main thread).
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
