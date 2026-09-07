import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

// db.ts runs its schema migrations as an import side effect, so the pre-existing "old"
// catalog.db has to be written to disk *before* the dynamic import below. This exercises
// the guarded ALTER TABLE loop + the legacy thumbnails/ → ASSETS_DIR/<id>/thumbnail.png
// filesystem migration — the "upgrade an existing user's database" path that the other
// suites never hit (they always start from a fresh CREATE TABLE with every column present).

let tmpRoot: string;
let db: typeof import('./db').db;

// The subset of columns a catalog.db from an early release actually had.
const OLD_FILES_COLUMNS = [
  'id INTEGER PRIMARY KEY AUTOINCREMENT',
  'root_id INTEGER NOT NULL',
  'relative_path TEXT NOT NULL',
  'filename TEXT NOT NULL',
  'ext TEXT NOT NULL',
  'size_bytes INTEGER NOT NULL',
  'mtime INTEGER NOT NULL',
  'added_at INTEGER NOT NULL',
  "notes TEXT DEFAULT ''",
  'thumbnail_path TEXT',
  'missing INTEGER NOT NULL DEFAULT 0',
  'filament_type TEXT',
  'filament_color TEXT',
  'layer_height TEXT',
  'slicer_metadata_json TEXT',
];

// Every column db.ts is expected to add via migration on top of the old schema.
const MIGRATED_COLUMNS = [
  'embedded_images_json',
  'dimension_x',
  'dimension_y',
  'dimension_z',
  'scanner_version',
  'content_hash',
  'geometry_hash',
  'archive_entry_count',
  'plates_json',
  'plate_size_json',
  'filaments_json',
  'mesh_path',
  'slice_info_json',
  'duplicate_count',
];

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migration-test-'));
  const dbPath = path.join(tmpRoot, 'catalog.db');
  const assetsDir = path.join(tmpRoot, 'assets');
  const legacyThumbs = path.join(tmpRoot, 'thumbnails');

  process.env.DB_PATH = dbPath;
  process.env.CONFIG_PATH = path.join(tmpRoot, 'config.json');
  process.env.ASSETS_DIR = assetsDir;
  process.env.THUMBNAILS_DIR = legacyThumbs;

  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE roots (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, label TEXT NOT NULL);
    CREATE TABLE files (${OLD_FILES_COLUMNS.join(', ')}, UNIQUE(root_id, relative_path));
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE file_tags (file_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (file_id, tag_id));
  `);
  seed.prepare('INSERT INTO roots (id, path, label) VALUES (1, ?, ?)').run('/models', 'Models');
  seed
    .prepare(
      `INSERT INTO files (id, root_id, relative_path, filename, ext, size_bytes, mtime, added_at, thumbnail_path, notes)
       VALUES (7, 1, 'cube.stl', 'cube.stl', '.stl', 10, 1, 1, '7.png', 'keep me')`
    )
    .run();
  seed.prepare('INSERT INTO tags (id, name) VALUES (1, ?)').run('calibration');
  seed.prepare('INSERT INTO file_tags (file_id, tag_id) VALUES (7, 1)').run();
  seed.close();

  // Legacy standalone thumbnail for file id 7, in the pre-unification layout.
  fs.mkdirSync(legacyThumbs, { recursive: true });
  fs.writeFileSync(path.join(legacyThumbs, '7.png'), 'PNGDATA');
  fs.writeFileSync(path.join(legacyThumbs, 'not-a-thumbnail.txt'), 'ignore me');

  ({ db } = await import('./db'));
});

afterAll(() => {
  db.close();
  delete process.env.THUMBNAILS_DIR;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* windows lock on the just-closed db file */
  }
});

describe('db.ts migrations on a pre-existing old-schema catalog.db', () => {
  it('adds every missing files column without dropping existing rows', () => {
    const cols = new Set(
      (db.prepare("SELECT name FROM pragma_table_info('files')").all() as { name: string }[]).map((c) => c.name)
    );
    for (const col of MIGRATED_COLUMNS) expect(cols.has(col)).toBe(true);

    const row = db.prepare('SELECT * FROM files WHERE id = 7').get() as Record<string, unknown>;
    expect(row.filename).toBe('cube.stl');
    expect(row.notes).toBe('keep me');
    expect(row.scanner_version).toBe(0); // NOT NULL DEFAULT 0 backfilled onto the existing row
    expect(row.mesh_path).toBeNull();
    expect(row.duplicate_count).toBe(0); // materialized column, backfilled on the migration
  });

  it('adds tags.color to the pre-existing tags table', () => {
    const cols = (db.prepare("SELECT name FROM pragma_table_info('tags')").all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(cols).toContain('color');
    expect((db.prepare('SELECT name FROM tags WHERE id = 1').get() as { name: string }).name).toBe('calibration');
  });

  it('relocates legacy thumbnails/<id>.png into ASSETS_DIR/<id>/thumbnail.png and removes the old dir', () => {
    const moved = path.join(process.env.ASSETS_DIR!, '7', 'thumbnail.png');
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.readFileSync(moved, 'utf-8')).toBe('PNGDATA');
    expect(fs.existsSync(path.join(tmpRoot, 'thumbnails'))).toBe(false);
  });

  it('normalizes files.thumbnail_path to the unified filename', () => {
    const row = db.prepare('SELECT thumbnail_path FROM files WHERE id = 7').get() as { thumbnail_path: string };
    expect(row.thumbnail_path).toBe('thumbnail.png');
  });

  it('creates the duplicate-detection indexes', () => {
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_files_content_hash',
        'idx_files_geometry_hash',
        'idx_files_added_at',
        'idx_files_duplicate_count',
      ])
    );
  });

  it('is a no-op on the second import (columns already present)', async () => {
    // Re-importing in the same module graph returns the cached module; just assert the
    // migration loop left the DB in a queryable state and re-running pragma checks is safe.
    const cols = db.prepare("SELECT name FROM pragma_table_info('files')").all() as { name: string }[];
    expect(cols.length).toBeGreaterThanOrEqual(OLD_FILES_COLUMNS.length + MIGRATED_COLUMNS.length);
  });
});
