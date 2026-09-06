import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

let tmpRoot: string;
let filesDir: string;
let db: typeof import('./db').db;
let saveConfig: typeof import('./config').saveConfig;
let runScan: typeof import('./scanner').runScan;

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-scanner-test-'));
  filesDir = path.join(tmpRoot, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  process.env.DB_PATH = path.join(tmpRoot, 'test.db');
  process.env.CONFIG_PATH = path.join(tmpRoot, 'config.json');
  process.env.THUMBNAILS_DIR = path.join(tmpRoot, 'thumbnails');
  process.env.ASSETS_DIR = path.join(tmpRoot, 'assets');

  ({ db } = await import('./db'));
  ({ saveConfig } = await import('./config'));
  ({ runScan } = await import('./scanner'));

  saveConfig({ roots: [{ label: 'Test Root', path: filesDir }] });
});

afterAll(() => {
  db.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold a lock on the just-closed db file; not worth failing the suite over.
  }
});

function writeStl(name: string) {
  fs.writeFileSync(path.join(filesDir, name), 'solid x\nendsolid x\n');
}

function writeBinaryStlWithKnownSize(name: string, size: [number, number, number]) {
  const [sx, sy, sz] = size;
  const buf = Buffer.alloc(84 + 50);
  buf.writeUInt32LE(1, 80);
  let offset = 84 + 12; // skip normal
  const vertices: [number, number, number][] = [
    [0, 0, 0],
    [sx, sy, 0],
    [0, 0, sz],
  ];
  for (const [x, y, z] of vertices) {
    buf.writeFloatLE(x, offset);
    buf.writeFloatLE(y, offset + 4);
    buf.writeFloatLE(z, offset + 8);
    offset += 12;
  }
  fs.writeFileSync(path.join(filesDir, name), buf);
}

function writeBambu3mf(name: string, imageBuffer: Buffer = Buffer.from('fake-png-bytes')) {
  const zip = new AdmZip();
  zip.addFile('Metadata/plate_1.png', imageBuffer);
  zip.addFile(
    'Metadata/project_settings.config',
    Buffer.from(JSON.stringify({ filament_type: ['ABS'], layer_height: ['0.28'] }))
  );
  zip.addFile(
    '3D/3dmodel.model',
    Buffer.from(
      '<model><resources><object id="1"><mesh><vertices>' +
        '<vertex x="0" y="0" z="0" /><vertex x="25" y="0" z="0" />' +
        '<vertex x="0" y="12" z="0" /><vertex x="0" y="0" z="8" />' +
        '</vertices></mesh></object></resources></model>'
    )
  );
  zip.writeZip(path.join(filesDir, name));
}

describe('runScan', () => {
  it('adds new files found under a configured root', async () => {
    writeStl('cube.stl');

    const result = await runScan();

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.missing).toBe(0);

    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('cube.stl') as any;
    expect(row).toBeTruthy();
    expect(row.ext).toBe('.stl');
    expect(row.missing).toBe(0);
  });

  it('is idempotent on an unchanged file', async () => {
    const result = await runScan();
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.missing).toBe(0);
  });

  it('extracts a Bambu thumbnail and filament metadata for a new 3mf', async () => {
    writeBambu3mf('bambu.3mf');

    const result = await runScan();

    expect(result.added).toBe(1);
    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('bambu.3mf') as any;
    expect(row.filament_type).toBe('ABS');
    expect(row.layer_height).toBe('0.28');
    expect(row.thumbnail_path).toBeTruthy();
    expect(row.dimension_x).toBeCloseTo(25);
    expect(row.dimension_y).toBeCloseTo(12);
    expect(row.dimension_z).toBeCloseTo(8);

    const thumbPath = path.join(process.env.THUMBNAILS_DIR!, row.thumbnail_path);
    expect(fs.existsSync(thumbPath)).toBe(true);
  });

  it('caches embedded 3mf images as WebP files under the assets directory', async () => {
    writeBambu3mf('bambu-with-images.3mf', ONE_PIXEL_PNG);

    await runScan();

    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('bambu-with-images.3mf') as any;
    expect(row.embedded_images_json).toBeTruthy();

    const names: string[] = JSON.parse(row.embedded_images_json);
    expect(names).toContain('plate_1.webp');

    for (const name of names) {
      const assetPath = path.join(process.env.ASSETS_DIR!, String(row.id), name);
      expect(fs.existsSync(assetPath)).toBe(true);
    }
  });

  it('computes and stores model dimensions for a new STL', async () => {
    writeBinaryStlWithKnownSize('sized.stl', [30, 40, 15]);

    await runScan();

    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('sized.stl') as any;
    expect(row.dimension_x).toBeCloseTo(30);
    expect(row.dimension_y).toBeCloseTo(40);
    expect(row.dimension_z).toBeCloseTo(15);
  });

  it('recomputes dimensions when a file changes size on disk', async () => {
    writeBinaryStlWithKnownSize('resizing.stl', [10, 10, 10]);
    await runScan();
    let row = db.prepare('SELECT * FROM files WHERE filename = ?').get('resizing.stl') as any;
    expect(row.dimension_x).toBeCloseTo(10);

    // Bump mtime forward so the scanner treats this as a changed file even though the
    // geometry write below could in principle land in the same millisecond.
    writeBinaryStlWithKnownSize('resizing.stl', [50, 50, 50]);
    fs.utimesSync(path.join(filesDir, 'resizing.stl'), new Date(), new Date(Date.now() + 5000));
    await runScan();

    row = db.prepare('SELECT * FROM files WHERE filename = ?').get('resizing.stl') as any;
    expect(row.dimension_x).toBeCloseTo(50);
  });

  it('leaves dimensions null for a file with no parseable geometry', async () => {
    writeStl('empty-geometry.stl');

    await runScan();

    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('empty-geometry.stl') as any;
    expect(row.dimension_x).toBeNull();
    expect(row.dimension_y).toBeNull();
    expect(row.dimension_z).toBeNull();
  });

  it('backfills dimensions on a rescan of a row stuck at scanner_version 0, even though mtime is unchanged', async () => {
    writeBinaryStlWithKnownSize('legacy.stl', [7, 8, 9]);
    await runScan();
    const before = db.prepare('SELECT * FROM files WHERE filename = ?').get('legacy.stl') as any;
    expect(before.dimension_x).toBeCloseTo(7);

    // Simulate a row scanned by code that predates this backfill tracking: same mtime on
    // disk, but scanner_version reset to 0 (exactly what a pre-existing catalog.db has after
    // the ALTER TABLE migration — new columns default to 0, not "already caught up").
    db.prepare(
      'UPDATE files SET dimension_x = NULL, dimension_y = NULL, dimension_z = NULL, scanner_version = 0 WHERE id = ?'
    ).run(before.id);

    const result = await runScan();

    const after = db.prepare('SELECT * FROM files WHERE filename = ?').get('legacy.stl') as any;
    expect(after.dimension_x).toBeCloseTo(7);
    expect(after.dimension_y).toBeCloseTo(8);
    expect(after.dimension_z).toBeCloseTo(9);
    expect(after.scanner_version).toBeGreaterThan(0);
    expect(result.updated).toBeGreaterThanOrEqual(1);
  });

  it('does not keep reprocessing a file that legitimately has no parseable geometry', async () => {
    writeStl('no-geometry.stl');
    await runScan();
    const first = db.prepare('SELECT * FROM files WHERE filename = ?').get('no-geometry.stl') as any;
    expect(first.dimension_x).toBeNull();
    expect(first.scanner_version).toBeGreaterThan(0);

    // Rescanning again with mtime still unchanged and scanner_version already caught up
    // should not touch this file — confirms backfill is driven by scanner_version, not by
    // "dimension_x is still null", which would retry forever for a file with no geometry.
    const result = await runScan();
    expect(result.updated).toBe(0);
  });

  it('backfills 3mf metadata and embedded images on a rescan of a row that predates that feature', async () => {
    writeBambu3mf('legacy.3mf', ONE_PIXEL_PNG);
    await runScan();
    const before = db.prepare('SELECT * FROM files WHERE filename = ?').get('legacy.3mf') as any;
    expect(before.slicer_metadata_json).toBeTruthy();

    db.prepare(
      `UPDATE files SET slicer_metadata_json = NULL, embedded_images_json = NULL,
       filament_type = NULL, thumbnail_path = NULL, scanner_version = 0 WHERE id = ?`
    ).run(before.id);

    await runScan();

    const after = db.prepare('SELECT * FROM files WHERE filename = ?').get('legacy.3mf') as any;
    expect(after.slicer_metadata_json).toBeTruthy();
    expect(after.filament_type).toBe('ABS');
    expect(after.embedded_images_json).toBeTruthy();
    expect(after.thumbnail_path).toBeTruthy();
  });

  it('computes content and geometry hashes for a new file', async () => {
    writeBinaryStlWithKnownSize('hashed.stl', [11, 12, 13]);

    await runScan();

    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('hashed.stl') as any;
    expect(row.content_hash).toBeTruthy();
    expect(row.geometry_hash).toBeTruthy();
  });

  it('gives byte-identical files the same content hash', async () => {
    writeStl('twin-a.stl');
    fs.writeFileSync(path.join(filesDir, 'twin-b.stl'), fs.readFileSync(path.join(filesDir, 'twin-a.stl')));

    await runScan();

    const a = db.prepare('SELECT content_hash FROM files WHERE filename = ?').get('twin-a.stl') as any;
    const b = db.prepare('SELECT content_hash FROM files WHERE filename = ?').get('twin-b.stl') as any;
    expect(a.content_hash).toBe(b.content_hash);
  });

  it('groups embedded images into plates_json for a Bambu 3mf', async () => {
    writeBambu3mf('plated.3mf', ONE_PIXEL_PNG);

    await runScan();

    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('plated.3mf') as any;
    expect(row.plates_json).toBeTruthy();
    const plates = JSON.parse(row.plates_json);
    expect(plates).toEqual([{ index: 1, images: ['plate_1.webp'] }]);
  });

  it('backfills content/geometry hashes and plates_json on a rescan of a row stuck at scanner_version 0', async () => {
    writeBambu3mf('legacy-hash.3mf', ONE_PIXEL_PNG);
    await runScan();
    const before = db.prepare('SELECT * FROM files WHERE filename = ?').get('legacy-hash.3mf') as any;
    expect(before.content_hash).toBeTruthy();

    db.prepare(
      'UPDATE files SET content_hash = NULL, geometry_hash = NULL, plates_json = NULL, scanner_version = 0 WHERE id = ?'
    ).run(before.id);

    await runScan();

    const after = db.prepare('SELECT * FROM files WHERE filename = ?').get('legacy-hash.3mf') as any;
    expect(after.content_hash).toBeTruthy();
    expect(after.geometry_hash).toBeTruthy();
    expect(after.plates_json).toBeTruthy();
  });

  it('counts the model entries inside a scanned zip archive', async () => {
    const zip = new AdmZip();
    zip.addFile('Models/a.stl', Buffer.from('solid a\nendsolid a\n'));
    zip.addFile('Models/b.stl', Buffer.from('solid b\nendsolid b\n'));
    zip.addFile('readme.txt', Buffer.from('not a model'));
    zip.writeZip(path.join(filesDir, 'bundle.zip'));

    const result = await runScan();

    expect(result.added).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('bundle.zip') as any;
    expect(row.ext).toBe('.zip');
    expect(row.archive_entry_count).toBe(2);
    expect(row.content_hash).toBeTruthy();
  });

  it('scopes a scan to a single root when given a rootLabel, leaving other roots untouched', async () => {
    const rootB = path.join(tmpRoot, 'files-b');
    fs.mkdirSync(rootB, { recursive: true });
    fs.writeFileSync(path.join(rootB, 'only-in-b.stl'), 'solid b\nendsolid b\n');
    saveConfig({ roots: [{ label: 'Test Root', path: filesDir }, { label: 'Root B', path: rootB }] });

    // Scanning only Root B must not touch Test Root's rows...
    const bResult = await runScan({ rootLabel: 'Root B' });
    expect(bResult.added).toBe(1);
    expect(db.prepare('SELECT id FROM files WHERE filename = ?').get('only-in-b.stl')).toBeTruthy();

    // ...and deleting a Test Root file while scanning only Root B must not flag it missing.
    fs.unlinkSync(path.join(filesDir, 'cube.stl'));
    const bAgain = await runScan({ rootLabel: 'Root B' });
    expect(bAgain.missing).toBe(0);
    expect((db.prepare('SELECT missing FROM files WHERE filename = ?').get('cube.stl') as any).missing).toBe(0);

    // A scoped scan of Test Root now sees the deletion.
    const aResult = await runScan({ rootLabel: 'Test Root' });
    expect(aResult.missing).toBe(1);

    // Restore single-root config and the file for the remaining tests.
    writeStl('cube.stl');
    saveConfig({ roots: [{ label: 'Test Root', path: filesDir }] });
    await runScan();
  });

  it('flags a file as missing once it is deleted from disk', async () => {
    fs.unlinkSync(path.join(filesDir, 'cube.stl'));

    const result = await runScan();

    expect(result.missing).toBe(1);
    const row = db.prepare('SELECT missing FROM files WHERE filename = ?').get('cube.stl') as any;
    expect(row.missing).toBe(1);
  });

  it('un-flags a file as missing if it reappears', async () => {
    writeStl('cube.stl');

    const result = await runScan();

    expect(result.missing).toBe(0);
    const row = db.prepare('SELECT missing FROM files WHERE filename = ?').get('cube.stl') as any;
    expect(row.missing).toBe(0);
  });
});
