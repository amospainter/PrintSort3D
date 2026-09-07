import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { db } from './db';
import { loadConfig, saveConfig, RootConfig, PlateSize } from './config';
import { runScan, rescanFile, isScanning } from './scanner';
import { ASSETS_DIR } from './paths';
import { deleteCachedImages, thumbnailFilePath, BAKED_MESH_FILENAME } from './assets';
import { listArchiveModelEntries, readArchiveEntry } from './archive';

export const router = Router();

interface FileRow {
  id: number;
  root_id: number;
  relative_path: string;
  filename: string;
  ext: string;
  size_bytes: number;
  mtime: number;
  added_at: number;
  notes: string;
  thumbnail_path: string | null;
  missing: number;
  filament_type: string | null;
  filament_color: string | null;
  filaments_json: string | null;
  layer_height: string | null;
  slicer_metadata_json: string | null;
  embedded_images_json: string | null;
  dimension_x: number | null;
  dimension_y: number | null;
  dimension_z: number | null;
  content_hash: string | null;
  geometry_hash: string | null;
  archive_entry_count: number | null;
  plates_json: string | null;
  plate_size_json: string | null;
  mesh_path: string | null;
  slice_info_json: string | null;
  root_label?: string;
  root_path?: string;
  tags?: string;
  duplicate_count?: number;
}

interface DuplicateRow {
  id: number;
  filename: string;
  relative_path: string;
  root_label: string;
  match_type: 'exact' | 'geometry';
}

function findDuplicates(row: FileRow): DuplicateRow[] {
  if (!row.content_hash && !row.geometry_hash) return [];
  const results = db
    .prepare(
      `SELECT f.id, f.filename, f.relative_path, r.label as root_label,
         CASE WHEN ? IS NOT NULL AND f.content_hash = ? THEN 'exact' ELSE 'geometry' END as match_type
       FROM files f JOIN roots r ON r.id = f.root_id
       WHERE f.id != ? AND (
         (? IS NOT NULL AND f.content_hash = ?) OR
         (? IS NOT NULL AND f.geometry_hash = ?)
       )`
    )
    .all(
      row.content_hash,
      row.content_hash,
      row.id,
      row.content_hash,
      row.content_hash,
      row.geometry_hash,
      row.geometry_hash
    ) as unknown as DuplicateRow[];
  return results;
}

function serializeFile(row: FileRow, defaultPlateSize: PlateSize, opts: { summary?: boolean } = {}) {
  const parsedPlateSize = row.plate_size_json
    ? (JSON.parse(row.plate_size_json) as PlateSize)
    : null;
  return {
    id: row.id,
    filename: row.filename,
    ext: row.ext,
    sizeBytes: row.size_bytes,
    mtime: row.mtime,
    addedAt: row.added_at,
    notes: row.notes,
    thumbnailUrl: row.thumbnail_path ? `/api/files/${row.id}/thumbnail` : null,
    missing: !!row.missing,
    root: { label: row.root_label, path: row.root_path },
    relativePath: row.relative_path,
    filamentType: row.filament_type,
    filamentColor: row.filament_color,
    filaments: row.filaments_json
      ? (JSON.parse(row.filaments_json) as { color: string; type: string | null }[])
      : [],
    layerHeight: row.layer_height,
    // The raw slicer-settings blob is large (can be 40-50 KB per 3MF) and only the Detail
    // page reads it, so list responses omit it entirely — see LIST_QUERY.
    ...(opts.summary
      ? {}
      : { slicerMetadata: row.slicer_metadata_json ? JSON.parse(row.slicer_metadata_json) : null }),
    embeddedImages: row.embedded_images_json
      ? (JSON.parse(row.embedded_images_json) as string[]).map((name) => `/api/assets/${row.id}/${name}`)
      : [],
    dimensions:
      row.dimension_x != null && row.dimension_y != null && row.dimension_z != null
        ? { x: row.dimension_x, y: row.dimension_y, z: row.dimension_z }
        : null,
    tags: row.tags ? row.tags.split('||').filter(Boolean) : [],
    contentHash: row.content_hash,
    geometryHash: row.geometry_hash,
    duplicateCount: row.duplicate_count ?? 0,
    archiveEntryCount: row.archive_entry_count,
    plates: row.plates_json
      ? (
          JSON.parse(row.plates_json) as {
            index: number;
            images: string[];
            buildItemIndices?: number[];
            name?: string;
          }[]
        ).map((p) => ({
          index: p.index,
          images: p.images.map((name) => `/api/assets/${row.id}/${name}`),
          buildItemIndices: p.buildItemIndices,
          name: p.name,
        }))
      : [],
    // Bambu/Orca slicing result (Metadata/slice_info.config): print time, filament weight/
    // length, printer model, supports. null for non-3MF, unsliced, or PrusaSlicer files.
    // Small enough to include in list responses (card badges + sorting).
    sliceInfo: row.slice_info_json ? JSON.parse(row.slice_info_json) : null,
    // Actual declared plate footprint when known (Bambu/Orca 3MF), else the app-wide default
    // so the viewer always has a bed to draw. `plateSizeSource` lets the UI show which it is.
    bedSize: parsedPlateSize ?? { ...defaultPlateSize },
    plateSizeSource: parsedPlateSize ? ('file' as const) : ('default' as const),
    // Pre-baked binary mesh (positions + indices, plus per-triangle filament slots for
    // painted 3MFs) the viewer loads instead of parsing the source file in the browser.
    // null when the bake found no geometry or the file predates scanner v8 — viewer then
    // falls back to fetching the raw file.
    meshUrl: row.mesh_path ? `/api/files/${row.id}/mesh` : null,
  };
}

function serialize(row: FileRow) {
  return serializeFile(row, loadConfig().defaultPlateSize);
}

const DUPLICATE_MATCH_SQL = `
  (f.content_hash IS NOT NULL AND f2.content_hash = f.content_hash) OR
  (f.geometry_hash IS NOT NULL AND f2.geometry_hash = f.geometry_hash)
`;

const TAGS_AND_DUPES = `
    (SELECT GROUP_CONCAT(t.name, '||') FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id) as tags,
    (SELECT COUNT(*) FROM files f2 WHERE f2.id != f.id AND (${DUPLICATE_MATCH_SQL})) as duplicate_count
`;

// Detail / single-file responses: every column, including the big slicer_metadata_json blob.
const BASE_QUERY = `
  SELECT f.*, r.label as root_label, r.path as root_path,
${TAGS_AND_DUPES}
  FROM files f JOIN roots r ON r.id = f.root_id
`;

// List responses: every column the Library UI needs, but NOT slicer_metadata_json — that
// blob was measured at ~96% of a list payload and is only read by the Detail page.
const LIST_QUERY = `
  SELECT
    f.id, f.root_id, f.relative_path, f.filename, f.ext, f.size_bytes, f.mtime, f.added_at,
    f.notes, f.thumbnail_path, f.missing, f.filament_type, f.filament_color, f.filaments_json,
    f.layer_height, f.embedded_images_json, f.dimension_x, f.dimension_y, f.dimension_z,
    f.content_hash, f.geometry_hash, f.archive_entry_count, f.plates_json, f.plate_size_json,
    f.mesh_path, f.slice_info_json,
    r.label as root_label, r.path as root_path,
${TAGS_AND_DUPES}
  FROM files f JOIN roots r ON r.id = f.root_id
`;

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;

router.get('/files', (req, res) => {
  const { query, tags, ext, sort, duplicatesOnly, missingOnly, root, folder } = req.query as Record<
    string,
    string | undefined
  >;
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query) {
    clauses.push('f.filename LIKE ?');
    params.push(`%${query}%`);
  }
  if (folder) {
    // Recursive: everything at or below this directory. `relative_path` always ends in the
    // filename, so a `<folder>/%` prefix match on the separator-normalized path is enough —
    // no separate equality case. `\`, `%`, `_` in a folder name are escaped so they're
    // matched literally rather than acting as LIKE wildcards / the escape char itself.
    const norm = folder.replace(/\\/g, '/').replace(/\/+$/, '');
    const escaped = norm.replace(/[\\%_]/g, (c) => `\\${c}`);
    clauses.push("REPLACE(f.relative_path, '\\', '/') LIKE ? ESCAPE '\\'");
    params.push(`${escaped}/%`);
  }
  if (root) {
    // Matches by label (what the sidebar's "Sources" list shows/links with), not path —
    // paths are absolute filesystem strings the client shouldn't need to round-trip.
    clauses.push('r.label = ?');
    params.push(root);
  }
  if (ext) {
    clauses.push('f.ext = ?');
    params.push(ext.startsWith('.') ? ext : `.${ext}`);
  }
  if (tags) {
    // AND semantics: a file must carry every listed tag, not just one of them — one EXISTS
    // clause per tag rather than a single IN(...) (which would OR-match on any of them).
    const tagList = tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    for (const t of tagList) {
      clauses.push('EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND t.name = ?)');
      params.push(t);
    }
  }
  if (duplicatesOnly === '1' || duplicatesOnly === 'true') {
    clauses.push(`EXISTS (SELECT 1 FROM files f2 WHERE f2.id != f.id AND (${DUPLICATE_MATCH_SQL}))`);
  }
  if (missingOnly === '1' || missingOnly === 'true') {
    clauses.push('f.missing = 1');
  }

  const whereClause = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';

  const sortMap: Record<string, { col: string; defaultDir: 'ASC' | 'DESC' }> = {
    name: { col: 'f.filename', defaultDir: 'ASC' },
    size: { col: 'f.size_bytes', defaultDir: 'DESC' },
    added: { col: 'f.added_at', defaultDir: 'DESC' },
    mtime: { col: 'f.mtime', defaultDir: 'DESC' },
    // Print estimates live in slice_info_json (Bambu/Orca sliced 3MFs only). Files without
    // it sort as NULL — last under DESC ("longest print first"), which is the useful default.
    printTime: { col: "json_extract(f.slice_info_json, '$.printTimeSeconds')", defaultDir: 'DESC' },
    filament: { col: "json_extract(f.slice_info_json, '$.filamentWeightGrams')", defaultDir: 'DESC' },
  };
  const sortSpec = sortMap[sort ?? 'added'] ?? sortMap.added;
  const dir = (req.query.dir as string | undefined)?.toUpperCase() === 'ASC' ? 'ASC' : (req.query.dir as string | undefined)?.toUpperCase() === 'DESC' ? 'DESC' : sortSpec.defaultDir;
  // Stable tiebreak so paging can't drop or repeat a row when the sort key ties.
  const orderBy = `${sortSpec.col} ${dir}, f.id ${dir}`;

  const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * pageSize;

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM files f JOIN roots r ON r.id = f.root_id${whereClause}`)
    .get(...(params as (string | number)[])) as { count: number };
  const total = totalRow.count;

  const sql = `${LIST_QUERY}${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...(params as (string | number)[]), pageSize, offset) as unknown as FileRow[];

  const { defaultPlateSize } = loadConfig();
  res.json({
    items: rows.map((r) => serializeFile(r, defaultPlateSize, { summary: true })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

router.get('/files/:id', (req, res) => {
  const row = db.prepare(BASE_QUERY + ' WHERE f.id = ?').get(req.params.id) as unknown as FileRow | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    ...serialize(row),
    duplicates: findDuplicates(row).map((d) => ({
      id: d.id,
      filename: d.filename,
      relativePath: d.relative_path,
      rootLabel: d.root_label,
      matchType: d.match_type,
    })),
  });
});

// Removes files flagged `missing` from the catalogue — the row, its tags, and its cached
// assets. Never touches disk (a missing file has no disk presence anyway). `?root=<label>`
// scopes it; otherwise every missing file across every root. Returns { removed: number }.
router.post('/files/purge-missing', (req, res) => {
  const rootLabel = (req.query.root as string | undefined) ?? (req.body as { root?: string } | undefined)?.root;
  let rows: { id: number }[];
  if (rootLabel) {
    rows = db
      .prepare(
        'SELECT f.id FROM files f JOIN roots r ON r.id = f.root_id WHERE f.missing = 1 AND r.label = ?'
      )
      .all(rootLabel) as { id: number }[];
  } else {
    rows = db.prepare('SELECT id FROM files WHERE missing = 1').all() as { id: number }[];
  }

  try {
    db.exec('BEGIN IMMEDIATE');
    for (const { id } of rows) {
      db.prepare('DELETE FROM file_tags WHERE file_id = ?').run(id);
      db.prepare('DELETE FROM files WHERE id = ?').run(id);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no active transaction */
    }
    console.error('purge-missing failed:', err);
    return res.status(500).json({ error: 'purge failed', message: err instanceof Error ? err.message : String(err) });
  }

  // Asset teardown is outside the transaction — it's filesystem work, and a row that's
  // already gone from the DB with a leftover asset dir is harmless (the startup prune and
  // the next purge both mop it up).
  for (const { id } of rows) deleteCachedImages(id);

  res.json({ removed: rows.length });
});

// Removes a single missing file from the catalogue (row + tags + cached assets). 409 if the
// file isn't flagged missing — deleting a present file just invites it back on the next scan.
router.delete('/files/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare('SELECT missing FROM files WHERE id = ?').get(id) as { missing: number } | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!row.missing) {
    return res.status(409).json({ error: 'file is present on disk; only missing files can be removed from the catalogue' });
  }

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM file_tags WHERE file_id = ?').run(id);
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no active transaction */
    }
    return res.status(500).json({ error: 'delete failed', message: err instanceof Error ? err.message : String(err) });
  }
  deleteCachedImages(id);
  res.json({ ok: true });
});

router.patch('/files/:id', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM files WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });

  const { notes, tags } = req.body as { notes?: string; tags?: string[] };

  // One transaction so a failure partway through the tag rebuild can't leave the file with
  // its old tags deleted and the new ones not written (which looked like "tags didn't save").
  try {
    db.exec('BEGIN IMMEDIATE');

    if (typeof notes === 'string') {
      db.prepare('UPDATE files SET notes = ? WHERE id = ?').run(notes, id);
    }

    if (Array.isArray(tags)) {
      db.prepare('DELETE FROM file_tags WHERE file_id = ?').run(id);
      for (const rawName of tags) {
        const name = rawName.trim().toLowerCase();
        if (!name) continue;
        let tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number } | undefined;
        if (!tagRow) {
          const info = db.prepare('INSERT INTO tags (name) VALUES (?)').run(name);
          tagRow = { id: info.lastInsertRowid as number };
        }
        db.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)').run(id, tagRow.id);
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no active transaction */
    }
    console.error(`Failed to update file ${id}:`, err);
    return res.status(500).json({ error: 'update failed', message: err instanceof Error ? err.message : String(err) });
  }

  const row = db.prepare(BASE_QUERY + ' WHERE f.id = ?').get(id) as unknown as FileRow;
  res.json(serialize(row));
});

// Bulk tag edit: add and/or remove a set of tags across many files in one transaction.
// Used by the Library's multi-select bulk-tag toolbar. `add` tags are created on demand
// (same normalization as PATCH /files/:id); `remove` tags that don't exist are ignored.
router.post('/files/bulk-tags', (req, res) => {
  const { fileIds, add, remove } = req.body as { fileIds?: unknown; add?: unknown; remove?: unknown };
  const ids = Array.isArray(fileIds) ? [...new Set(fileIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  const addNames = Array.isArray(add) ? add.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : [];
  const removeNames = Array.isArray(remove) ? remove.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'fileIds required' });
  if (addNames.length === 0 && removeNames.length === 0) return res.status(400).json({ error: 'add or remove required' });

  try {
    db.exec('BEGIN IMMEDIATE');

    const existingIds = ids.filter((id) => db.prepare('SELECT 1 FROM files WHERE id = ?').get(id));

    for (const name of addNames) {
      let tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number } | undefined;
      if (!tagRow) {
        const info = db.prepare('INSERT INTO tags (name) VALUES (?)').run(name);
        tagRow = { id: info.lastInsertRowid as number };
      }
      for (const id of existingIds) {
        db.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)').run(id, tagRow.id);
      }
    }

    for (const name of removeNames) {
      const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number } | undefined;
      if (!tagRow) continue;
      for (const id of existingIds) {
        db.prepare('DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?').run(id, tagRow.id);
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no active transaction */
    }
    console.error('Bulk tag update failed:', err);
    return res.status(500).json({ error: 'bulk update failed', message: err instanceof Error ? err.message : String(err) });
  }

  res.json({ updated: ids.length });
});

interface TagRow {
  name: string;
  color: string | null;
  count: number;
}

// #rrgb / #rrggbb only — the client's preset swatches and <input type="color"> both emit
// this, and it keeps the value safe to drop straight into a style attribute.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

router.get('/tags', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT t.name, t.color, (SELECT COUNT(*) FROM file_tags ft WHERE ft.tag_id = t.id) as count
       FROM tags t ORDER BY t.name`
    )
    .all() as unknown as TagRow[];
  res.json(rows);
});

router.patch('/tags/:name', (req, res) => {
  const name = String(req.params.name).trim().toLowerCase();
  const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number } | undefined;
  if (!tag) return res.status(404).json({ error: 'not found' });

  const { color } = req.body as { color?: string | null };
  if (color !== null && color !== undefined && !HEX_COLOR_RE.test(color)) {
    return res.status(400).json({ error: 'color must be a hex string like #4a90e2, or null' });
  }
  db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color ?? null, tag.id);

  const row = db
    .prepare(
      `SELECT t.name, t.color, (SELECT COUNT(*) FROM file_tags ft WHERE ft.tag_id = t.id) as count
       FROM tags t WHERE t.id = ?`
    )
    .get(tag.id) as unknown as TagRow;
  res.json(row);
});

router.delete('/tags/:name', (req, res) => {
  const name = String(req.params.name).trim().toLowerCase();
  const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number } | undefined;
  if (!tag) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM file_tags WHERE tag_id = ?').run(tag.id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
  res.json({ ok: true });
});

router.get('/scan/status', (_req, res) => {
  res.json({ scanning: isScanning() });
});

router.post('/scan', async (req, res) => {
  try {
    // Optional `{ root: <label> }` scopes the scan to one watched folder; omitted = whole catalog.
    const { root } = (req.body ?? {}) as { root?: unknown };
    if (root !== undefined) {
      if (typeof root !== 'string' || !loadConfig().roots.some((r) => r.label === root)) {
        return res.status(404).json({ error: 'unknown root' });
      }
    }
    const result = await runScan(typeof root === 'string' ? { rootLabel: root } : {});
    res.json(result);
  } catch (err) {
    // runScan() already isolates per-file failures internally; this is a last-resort net
    // for anything unexpected (e.g. a bad root path) so the request 500s instead of the
    // rejection going unhandled and taking down the whole process.
    console.error('Scan failed:', err);
    res.status(500).json({ error: 'scan failed', message: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/files/:id/rescan', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  try {
    const status = await rescanFile(id);
    if (status === 'not_found') return res.status(404).json({ error: 'not found' });

    const row = db.prepare(BASE_QUERY + ' WHERE f.id = ?').get(id) as unknown as FileRow;
    res.json({
      ...serialize(row),
      duplicates: findDuplicates(row).map((d) => ({
        id: d.id,
        filename: d.filename,
        relativePath: d.relative_path,
        rootLabel: d.root_label,
        matchType: d.match_type,
      })),
      rescanStatus: status,
    });
  } catch (err) {
    // Same last-resort net as POST /scan — a single bad file shouldn't take the process down.
    console.error(`Rescan failed for file ${id}:`, err);
    res.status(500).json({ error: 'rescan failed', message: err instanceof Error ? err.message : String(err) });
  }
});

interface FolderEntry {
  root: string; // watched-folder label the directory lives under
  path: string; // "/"-joined path relative to that root, e.g. "vehicles/cars"
  name: string; // last path segment
  fileCount: number; // files at or below this directory (recursive)
}

// Directory tree derived purely from `files.relative_path` — there's no folders table.
// Every ancestor directory of every file is emitted (so intermediate dirs with no direct
// files still appear), each with a recursive file count. Powers the sidebar folder tree.
router.get('/folders', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT r.label as root_label, f.relative_path as relative_path
       FROM files f JOIN roots r ON r.id = f.root_id`
    )
    .all() as { root_label: string; relative_path: string }[];

  const counts = new Map<string, FolderEntry>();
  for (const { root_label, relative_path } of rows) {
    const parts = relative_path.split(/[\\/]/);
    parts.pop(); // drop the filename
    let acc = '';
    for (const part of parts) {
      if (!part) continue;
      acc = acc ? `${acc}/${part}` : part;
      const key = JSON.stringify([root_label, acc]);
      const entry = counts.get(key) ?? { root: root_label, path: acc, name: part, fileCount: 0 };
      entry.fileCount++;
      counts.set(key, entry);
    }
  }

  const folders = [...counts.values()].sort(
    (a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path)
  );
  res.json(folders);
});

router.get('/roots', (_req, res) => {
  const config = loadConfig();
  res.json(config.roots);
});

router.put('/roots', (req, res) => {
  // A deployment that owns its roots (Docker mounts, a locked-down host) can forbid editing
  // the watched-folder list entirely — managed roots already can't be removed, but this also
  // stops a caller *adding* an arbitrary server-readable path and reading files back out.
  if (/^(1|true|yes)$/i.test(process.env.PRINTSORT_ROOTS_LOCKED ?? '')) {
    return res.status(403).json({ error: 'watched folders are locked by the deployment' });
  }

  const roots = req.body as RootConfig[];
  if (!Array.isArray(roots)) return res.status(400).json({ error: 'expected an array of roots' });

  const normPath = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const knownPaths = new Set(loadConfig().roots.map((r) => normPath(r.path)));

  for (const r of roots) {
    if (!r || typeof r.label !== 'string' || typeof r.path !== 'string' || !r.label.trim() || !r.path.trim()) {
      return res.status(400).json({ error: 'each root needs a non-empty label and path' });
    }
    if (!path.isAbsolute(r.path)) {
      return res.status(400).json({ error: `root path must be absolute: ${r.path}` });
    }
    // A newly-added root must exist and be a directory. An already-configured root whose
    // drive is temporarily offline is left alone — only paths that were never valid are rejected.
    if (!knownPaths.has(normPath(r.path))) {
      let isDir = false;
      try {
        isDir = fs.statSync(r.path).isDirectory();
      } catch {
        /* missing */
      }
      if (!isDir) return res.status(400).json({ error: `not a directory: ${r.path}` });
    }
  }

  // A root dropped from the list is gone for good (the user removed it deliberately),
  // so its catalog entries are deleted here rather than left to linger forever —
  // the scanner's missing-flag pass only ever looks at *currently configured* roots.
  // Managed (env-derived) roots are exempt: they're owned by the deployment and can't be
  // removed via the API, so a payload that omits one must not wipe its catalog entries.
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const managedPaths = new Set(loadConfig().roots.filter((r) => r.managed).map((r) => norm(r.path)));
  const keptPaths = new Set(roots.map((r) => norm(r.path)));
  const existingRoots = db.prepare('SELECT id, path FROM roots').all() as { id: number; path: string }[];
  const removedRootIds = existingRoots
    .filter((r) => !keptPaths.has(norm(r.path)) && !managedPaths.has(norm(r.path)))
    .map((r) => r.id);

  for (const rootId of removedRootIds) {
    const fileRows = db.prepare('SELECT id FROM files WHERE root_id = ?').all(rootId) as {
      id: number;
    }[];
    for (const f of fileRows) {
      // Removes the whole ASSETS_DIR/<id>/ tree — thumbnail, embedded WebPs, and baked mesh.
      deleteCachedImages(f.id);
    }
    db.prepare('DELETE FROM file_tags WHERE file_id IN (SELECT id FROM files WHERE root_id = ?)').run(rootId);
    db.prepare('DELETE FROM files WHERE root_id = ?').run(rootId);
    db.prepare('DELETE FROM roots WHERE id = ?').run(rootId);
  }

  saveConfig({ ...loadConfig(), roots });
  // Echo back the effective list (user roots as saved, plus any managed roots re-derived
  // from the environment) so the client stays in sync with what GET /api/roots returns.
  res.json(loadConfig().roots);
});

router.get('/settings', (_req, res) => {
  const config = loadConfig();
  res.json({ defaultPlateSize: config.defaultPlateSize });
});

router.put('/settings', (req, res) => {
  const { defaultPlateSize } = req.body as {
    defaultPlateSize?: { x?: unknown; y?: unknown };
  };
  const x = Number(defaultPlateSize?.x);
  const y = Number(defaultPlateSize?.y);
  if (!(x > 0) || !(y > 0)) {
    return res.status(400).json({ error: 'defaultPlateSize must have positive x and y (mm)' });
  }
  const config = loadConfig();
  saveConfig({ ...config, defaultPlateSize: { x, y } });
  res.json({ defaultPlateSize: { x, y } });
});

// Thumbnails are rendered server-side at scan time now (embedded plate image for Bambu
// 3MFs, else a CPU raster of the baked mesh — see scanner.ts / thumbnail.ts). There is no
// upload endpoint; this only serves the cached PNG.
router.get('/files/:id/thumbnail', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).end();
  const filePath = thumbnailFilePath(id);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.type('png').sendFile(filePath);
});

router.get('/files/:id/mesh', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).end();
  const row = db.prepare('SELECT mesh_path FROM files WHERE id = ?').get(id) as
    | { mesh_path: string | null }
    | undefined;
  if (!row?.mesh_path) return res.status(404).end();
  const filePath = path.join(ASSETS_DIR, String(id), BAKED_MESH_FILENAME);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  // Pre-gzipped on disk; the browser's fetch() inflates transparently.
  res.set('Content-Encoding', 'gzip').type('application/octet-stream').sendFile(filePath);
});

router.get('/assets/:fileId/:filename', (req, res) => {
  const { fileId, filename } = req.params;
  if (!/^\d+$/.test(fileId)) return res.status(400).end();
  if (!/^[a-zA-Z0-9._-]+\.webp$/.test(filename)) return res.status(400).end();

  const filePath = path.join(ASSETS_DIR, fileId, filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

interface ResolvedFile {
  fullPath: string;
  ext: string;
}

// Resolves a catalog file id to its absolute on-disk path, guarding against path traversal.
// `relative_path` is normally scanner-controlled and safe, but it's still trusted DB data,
// not re-validated per request, so the containment check stays even though callers are local.
function resolveFilePath(id: number): ResolvedFile | { error: 'not found' | 'invalid path' | 'missing on disk' } {
  const row = db
    .prepare(
      'SELECT f.relative_path as relative_path, f.ext as ext, r.path as root_path FROM files f JOIN roots r ON r.id = f.root_id WHERE f.id = ?'
    )
    .get(id) as { relative_path: string; ext: string; root_path: string } | undefined;
  if (!row) return { error: 'not found' };

  const rootResolved = path.resolve(row.root_path);
  const fullPath = path.resolve(rootResolved, row.relative_path);
  // Boundary check, not a bare prefix: `startsWith(root)` alone would accept a sibling like
  // `<root>-backup/...`. The path must BE the root or sit under `<root><sep>`.
  if (fullPath !== rootResolved && !fullPath.startsWith(rootResolved + path.sep)) {
    return { error: 'invalid path' };
  }
  if (!fs.existsSync(fullPath)) return { error: 'missing on disk' };

  return { fullPath, ext: row.ext };
}

router.get('/raw/:id', (req, res) => {
  const resolved = resolveFilePath(Number(req.params.id));
  if ('error' in resolved) {
    const status = resolved.error === 'not found' ? 404 : resolved.error === 'invalid path' ? 400 : 404;
    return res.status(status).json({ error: resolved.error });
  }
  // ?download=1 forces a save dialog (Content-Disposition: attachment) instead of inline
  // display — used by the client's "Download to open" button so a remote/LAN user gets the
  // file onto their own machine, where their slicer's file association takes over.
  if (req.query.download !== undefined) {
    return res.download(resolved.fullPath, path.basename(resolved.fullPath));
  }
  res.sendFile(resolved.fullPath);
});

router.get('/files/:id/archive', (req, res) => {
  const resolved = resolveFilePath(Number(req.params.id));
  if ('error' in resolved) {
    const status = resolved.error === 'not found' ? 404 : resolved.error === 'invalid path' ? 400 : 404;
    return res.status(status).json({ error: resolved.error });
  }
  if (resolved.ext !== '.zip') return res.status(400).json({ error: 'not an archive' });

  res.json(listArchiveModelEntries(resolved.fullPath));
});

router.get('/files/:id/archive-raw', (req, res) => {
  const resolved = resolveFilePath(Number(req.params.id));
  if ('error' in resolved) {
    const status = resolved.error === 'not found' ? 404 : resolved.error === 'invalid path' ? 400 : 404;
    return res.status(status).json({ error: resolved.error });
  }
  if (resolved.ext !== '.zip') return res.status(400).json({ error: 'not an archive' });

  const entryPath = req.query.path as string | undefined;
  if (!entryPath) return res.status(400).json({ error: 'path required' });

  // Re-derive the valid entry list rather than trusting the query param outright — it's
  // just a zip entry name (not a filesystem path), but this keeps the same "only what we
  // already enumerated" guarantee the rest of this app applies to trusted-but-unvalidated data.
  const entries = listArchiveModelEntries(resolved.fullPath);
  if (!entries.some((e) => e.path === entryPath)) return res.status(404).json({ error: 'entry not found' });

  const buffer = readArchiveEntry(resolved.fullPath, entryPath);
  if (!buffer) return res.status(404).json({ error: 'entry not found' });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(buffer);
});
