import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { db } from './db';
import { loadConfig, saveConfig, RootConfig, PlateSize } from './config';
import { runScan, rescanFile } from './scanner';
import { THUMBNAILS_DIR, ASSETS_DIR } from './paths';
import { deleteCachedImages, BAKED_MESH_FILENAME } from './assets';
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

function serializeFile(row: FileRow, defaultPlateSize: PlateSize) {
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
    thumbnailUrl: row.thumbnail_path ? `/api/thumbnails/${row.id}.png` : null,
    missing: !!row.missing,
    root: { label: row.root_label, path: row.root_path },
    relativePath: row.relative_path,
    filamentType: row.filament_type,
    filamentColor: row.filament_color,
    filaments: row.filaments_json
      ? (JSON.parse(row.filaments_json) as { color: string; type: string | null }[])
      : [],
    layerHeight: row.layer_height,
    slicerMetadata: row.slicer_metadata_json ? JSON.parse(row.slicer_metadata_json) : null,
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

const BASE_QUERY = `
  SELECT f.*, r.label as root_label, r.path as root_path,
    (SELECT GROUP_CONCAT(t.name, '||') FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id) as tags,
    (SELECT COUNT(*) FROM files f2 WHERE f2.id != f.id AND (${DUPLICATE_MATCH_SQL})) as duplicate_count
  FROM files f JOIN roots r ON r.id = f.root_id
`;

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;

router.get('/files', (req, res) => {
  const { query, tags, ext, sort, duplicatesOnly, root, folder } = req.query as Record<
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

  const whereClause = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';

  const sortMap: Record<string, string> = {
    name: 'f.filename',
    size: 'f.size_bytes',
    added: 'f.added_at',
    mtime: 'f.mtime',
  };
  const sortCol = sortMap[sort ?? 'added'] ?? 'f.added_at';

  const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * pageSize;

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM files f JOIN roots r ON r.id = f.root_id${whereClause}`)
    .get(...(params as (string | number)[])) as { count: number };
  const total = totalRow.count;

  const sql = `${BASE_QUERY}${whereClause} ORDER BY ${sortCol} DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...(params as (string | number)[]), pageSize, offset) as unknown as FileRow[];

  const { defaultPlateSize } = loadConfig();
  res.json({
    items: rows.map((r) => serializeFile(r, defaultPlateSize)),
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

router.patch('/files/:id', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM files WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });

  const { notes, tags } = req.body as { notes?: string; tags?: string[] };

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

  const row = db.prepare(BASE_QUERY + ' WHERE f.id = ?').get(id) as unknown as FileRow;
  res.json(serialize(row));
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
  const roots = req.body as RootConfig[];
  if (!Array.isArray(roots)) return res.status(400).json({ error: 'expected an array of roots' });

  // A root dropped from the list is gone for good (the user removed it deliberately),
  // so its catalog entries are deleted here rather than left to linger forever —
  // the scanner's missing-flag pass only ever looks at *currently configured* roots.
  const keptPaths = new Set(roots.map((r) => r.path));
  const existingRoots = db.prepare('SELECT id, path FROM roots').all() as { id: number; path: string }[];
  const removedRootIds = existingRoots.filter((r) => !keptPaths.has(r.path)).map((r) => r.id);

  for (const rootId of removedRootIds) {
    const fileRows = db.prepare('SELECT id, thumbnail_path FROM files WHERE root_id = ?').all(rootId) as {
      id: number;
      thumbnail_path: string | null;
    }[];
    for (const f of fileRows) {
      if (f.thumbnail_path) {
        try {
          fs.unlinkSync(path.join(THUMBNAILS_DIR, f.thumbnail_path));
        } catch {
          // thumbnail already gone; nothing to clean up
        }
      }
      deleteCachedImages(f.id);
    }
    db.prepare('DELETE FROM file_tags WHERE file_id IN (SELECT id FROM files WHERE root_id = ?)').run(rootId);
    db.prepare('DELETE FROM files WHERE root_id = ?').run(rootId);
    db.prepare('DELETE FROM roots WHERE id = ?').run(rootId);
  }

  saveConfig({ ...loadConfig(), roots });
  res.json(roots);
});

router.get('/settings', (_req, res) => {
  const config = loadConfig();
  res.json({ defaultPlateSize: config.defaultPlateSize });
});

router.put('/settings', (req, res) => {
  const { defaultPlateSize } = req.body as { defaultPlateSize?: { x?: unknown; y?: unknown } };
  const x = Number(defaultPlateSize?.x);
  const y = Number(defaultPlateSize?.y);
  if (!(x > 0) || !(y > 0)) {
    return res.status(400).json({ error: 'defaultPlateSize must have positive x and y (mm)' });
  }
  const config = loadConfig();
  saveConfig({ ...config, defaultPlateSize: { x, y } });
  res.json({ defaultPlateSize: { x, y } });
});

router.post('/files/:id/thumbnail', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM files WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });

  const { imageBase64 } = req.body as { imageBase64?: string };
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

  const base64Data = imageBase64.replace(/^data:image\/png;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(path.join(THUMBNAILS_DIR, `${id}.png`), buffer);
  db.prepare('UPDATE files SET thumbnail_path = ? WHERE id = ?').run(`${id}.png`, id);
  res.json({ ok: true });
});

router.get('/thumbnails/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^\d+\.png$/.test(filename)) return res.status(400).end();
  const filePath = path.join(THUMBNAILS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
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
  if (!fullPath.startsWith(rootResolved)) return { error: 'invalid path' };
  if (!fs.existsSync(fullPath)) return { error: 'missing on disk' };

  return { fullPath, ext: row.ext };
}

router.get('/raw/:id', (req, res) => {
  const resolved = resolveFilePath(Number(req.params.id));
  if ('error' in resolved) {
    const status = resolved.error === 'not found' ? 404 : resolved.error === 'invalid path' ? 400 : 404;
    return res.status(status).json({ error: resolved.error });
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
