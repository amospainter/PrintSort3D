import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { ASSETS_DIR } from './paths';

const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '..', 'catalog.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS roots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id INTEGER NOT NULL REFERENCES roots(id),
  relative_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  notes TEXT DEFAULT '',
  thumbnail_path TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  filament_type TEXT,
  filament_color TEXT,
  filaments_json TEXT,
  layer_height TEXT,
  slicer_metadata_json TEXT,
  embedded_images_json TEXT,
  dimension_x REAL,
  dimension_y REAL,
  dimension_z REAL,
  scanner_version INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  geometry_hash TEXT,
  archive_entry_count INTEGER,
  plates_json TEXT,
  plate_size_json TEXT,
  mesh_path TEXT,
  UNIQUE(root_id, relative_path)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS file_tags (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);
`);

// Lightweight migrations for databases created before these columns existed.
// CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so new columns need
// their own guarded ALTER TABLE — check pragma_table_info before adding each one.
const existingColumns = db.prepare("SELECT name FROM pragma_table_info('files')").all() as { name: string }[];
const columnNames = new Set(existingColumns.map((c) => c.name));

const migrations: [string, string][] = [
  ['embedded_images_json', 'ALTER TABLE files ADD COLUMN embedded_images_json TEXT'],
  ['dimension_x', 'ALTER TABLE files ADD COLUMN dimension_x REAL'],
  ['dimension_y', 'ALTER TABLE files ADD COLUMN dimension_y REAL'],
  ['dimension_z', 'ALTER TABLE files ADD COLUMN dimension_z REAL'],
  ['scanner_version', 'ALTER TABLE files ADD COLUMN scanner_version INTEGER NOT NULL DEFAULT 0'],
  ['content_hash', 'ALTER TABLE files ADD COLUMN content_hash TEXT'],
  ['geometry_hash', 'ALTER TABLE files ADD COLUMN geometry_hash TEXT'],
  ['archive_entry_count', 'ALTER TABLE files ADD COLUMN archive_entry_count INTEGER'],
  ['plates_json', 'ALTER TABLE files ADD COLUMN plates_json TEXT'],
  ['plate_size_json', 'ALTER TABLE files ADD COLUMN plate_size_json TEXT'],
  ['filaments_json', 'ALTER TABLE files ADD COLUMN filaments_json TEXT'],
  ['mesh_path', 'ALTER TABLE files ADD COLUMN mesh_path TEXT'],
];

for (const [column, sql] of migrations) {
  if (!columnNames.has(column)) {
    db.exec(sql);
  }
}

// Same guarded-ALTER pattern for the `tags` table (the loop above only covers `files`).
const tagColumns = new Set(
  (db.prepare("SELECT name FROM pragma_table_info('tags')").all() as { name: string }[]).map((c) => c.name)
);
if (!tagColumns.has('color')) {
  db.exec('ALTER TABLE tags ADD COLUMN color TEXT');
}

// One-time filesystem migration: thumbnails used to live in their own directory as
// `<id>.png`; they're now unified under ASSETS_DIR/<id>/thumbnail.png with the rest of a
// file's cached assets. Move any leftovers from the old layout, then drop its directory.
const legacyThumbnailsDir = process.env.THUMBNAILS_DIR ?? path.join(__dirname, '..', 'thumbnails');
try {
  if (fs.existsSync(legacyThumbnailsDir)) {
    for (const name of fs.readdirSync(legacyThumbnailsDir)) {
      const match = /^(\d+)\.png$/.exec(name);
      if (!match) continue;
      const destDir = path.join(ASSETS_DIR, match[1]);
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(path.join(legacyThumbnailsDir, name), path.join(destDir, 'thumbnail.png'));
    }
    fs.rmSync(legacyThumbnailsDir, { recursive: true, force: true });
  }
  db.exec(
    "UPDATE files SET thumbnail_path = 'thumbnail.png' WHERE thumbnail_path IS NOT NULL AND thumbnail_path <> 'thumbnail.png'"
  );
} catch (err) {
  console.error('Thumbnail unification migration failed:', err);
}

// Safe to run unconditionally: these reference columns guaranteed to exist by this point
// (either from CREATE TABLE on a fresh DB, or the migrations loop above on an existing one).
db.exec(`
CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash);
CREATE INDEX IF NOT EXISTS idx_files_geometry_hash ON files(geometry_hash);
`);
