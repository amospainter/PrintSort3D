import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import AdmZip from 'adm-zip';

let tmpRoot: string;
let filesDir: string;
let db: typeof import('./db').db;
let saveConfig: typeof import('./config').saveConfig;
let runScan: typeof import('./scanner').runScan;
let getScanProgress: typeof import('./scanner').getScanProgress;
let pendingReprocessCount: typeof import('./scanner').pendingReprocessCount;

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
  process.env.ASSETS_DIR = path.join(tmpRoot, 'assets');

  ({ db } = await import('./db'));
  ({ saveConfig } = await import('./config'));
  ({ runScan, getScanProgress, pendingReprocessCount } = await import('./scanner'));

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

function writeBambu3mf(
  name: string,
  imageBuffer: Buffer = Buffer.from('fake-png-bytes'),
  opts: { sliceInfo?: boolean } = {}
) {
  const zip = new AdmZip();
  zip.addFile('Metadata/plate_1.png', imageBuffer);
  if (opts.sliceInfo) {
    zip.addFile(
      'Metadata/slice_info.config',
      Buffer.from(
        '<config><plate>' +
          '<metadata key="index" value="1"/>' +
          '<metadata key="printer_model_id" value="C11"/>' +
          '<metadata key="prediction" value="4192"/>' +
          '<metadata key="weight" value="15.99"/>' +
          '<metadata key="support_used" value="false"/>' +
          '<filament id="1" type="PLA" color="#000000" used_m="5.29" used_g="15.99"/>' +
          '</plate></config>'
      )
    );
  }
  zip.addFile(
    'Metadata/project_settings.config',
    Buffer.from(
      JSON.stringify({
        filament_type: ['ABS', 'PLA'],
        filament_colour: ['#ff0000', '#00FF00'],
        layer_height: ['0.28'],
      })
    )
  );
  zip.addFile(
    '3D/3dmodel.model',
    Buffer.from(
      '<model><resources><object id="1"><mesh><vertices>' +
        '<vertex x="0" y="0" z="0" /><vertex x="25" y="0" z="0" />' +
        '<vertex x="0" y="12" z="0" /><vertex x="0" y="0" z="8" />' +
        '</vertices><triangles>' +
        '<triangle v1="0" v2="1" v3="2" paint_color="8"/>' +
        '<triangle v1="0" v2="1" v3="3" paint_color="4"/>' +
        '<triangle v1="1" v2="2" v3="3"/>' +
        '</triangles></mesh></object></resources>' +
        '<build><item objectid="1"/></build></model>'
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

    const thumbPath = path.join(process.env.ASSETS_DIR!, String(row.id), row.thumbnail_path);
    expect(fs.existsSync(thumbPath)).toBe(true);
    expect(row.thumbnail_path).toBe('thumbnail.png');
  });

  it('stores the full multi-color filament list (normalized) as filaments_json', async () => {
    writeBambu3mf('multicolor.3mf');

    await runScan();

    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('multicolor.3mf') as any;
    expect(JSON.parse(row.filaments_json)).toEqual([
      { color: '#FF0000', type: 'ABS' },
      { color: '#00FF00', type: 'PLA' },
    ]);
  });

  it('extracts slice_info.config (print time, filament weight) into slice_info_json', async () => {
    writeBambu3mf('sliced.3mf', ONE_PIXEL_PNG, { sliceInfo: true });

    await runScan();

    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('sliced.3mf') as any;
    const info = JSON.parse(row.slice_info_json);
    expect(info.printTimeSeconds).toBe(4192);
    expect(info.filamentWeightGrams).toBe(15.99);
    expect(info.printerModelId).toBe('C11');

    // A 3MF with no slice_info.config leaves the column null.
    writeBambu3mf('unsliced.3mf', ONE_PIXEL_PNG);
    await runScan();
    const bare = db.prepare('SELECT slice_info_json FROM files WHERE filename = ?').get('unsliced.3mf') as any;
    expect(bare.slice_info_json).toBeNull();
  });

  it('bakes a gzipped render mesh (mesh.bin.gz) with folded-in paint for a painted 3mf', async () => {
    writeBambu3mf('painted.3mf');

    await runScan();

    const row = db.prepare('SELECT * FROM files WHERE filename = ?').get('painted.3mf') as any;
    expect(row.mesh_path).toBe('mesh.bin.gz');

    const gz = fs.readFileSync(path.join(process.env.ASSETS_DIR!, String(row.id), 'mesh.bin.gz'));
    const blob = zlib.gunzipSync(gz);
    expect(blob.toString('ascii', 0, 4)).toBe('PSM1');
    expect(blob.readUInt32LE(4)).toBe(1); // one part
    expect(blob.readUInt32LE(8)).toBe(12); // floatCount = 4 verts × 3
    expect(blob.readUInt32LE(12)).toBe(9); // indexCount = 3 triangles × 3
    expect(blob.readUInt32LE(16) & 1).toBe(1); // flags: hasPaint
  });

  it('backfills mesh_path + bumps scanner_version to >= 8 on a rescan of a stale row', async () => {
    writeBambu3mf('stale-mesh.3mf');
    await runScan();
    db.prepare("UPDATE files SET mesh_path = NULL, scanner_version = 0 WHERE filename = 'stale-mesh.3mf'").run();

    await runScan();

    const after = db.prepare("SELECT * FROM files WHERE filename = 'stale-mesh.3mf'").get() as any;
    expect(after.mesh_path).toBe('mesh.bin.gz');
    expect(after.scanner_version).toBeGreaterThanOrEqual(8);
  });

  it('bakes a render mesh for a plain STL too', async () => {
    writeBinaryStlWithKnownSize('baked-cube.stl', [10, 20, 30]);
    await runScan();
    const row = db.prepare("SELECT * FROM files WHERE filename = 'baked-cube.stl'").get() as any;
    expect(row.mesh_path).toBe('mesh.bin.gz');
    const blob = zlib.gunzipSync(
      fs.readFileSync(path.join(process.env.ASSETS_DIR!, String(row.id), 'mesh.bin.gz'))
    );
    expect(blob.toString('ascii', 0, 4)).toBe('PSM1');
    expect(blob.readUInt32LE(12)).toBe(0); // non-indexed triangle soup
  });

  it('renders a server-side PNG thumbnail for a plain STL (no GPU) from the baked mesh', async () => {
    writeBinaryStlWithKnownSize('thumb-cube.stl', [10, 20, 30]);
    await runScan();
    const row = db.prepare("SELECT * FROM files WHERE filename = 'thumb-cube.stl'").get() as any;
    expect(row.thumbnail_path).toBe('thumbnail.png');

    const png = fs.readFileSync(path.join(process.env.ASSETS_DIR!, String(row.id), 'thumbnail.png'));
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('catalogues an .f3d (Fusion 360) file: preview thumbnail, no mesh/dimensions/geometry hash', async () => {
    const zip = new AdmZip();
    zip.addFile('Manifest.dat', Buffer.from('binary'));
    zip.addFile('FusionAssetName[Active]/Breps.BlobParts/BREP.abc.smb', Buffer.from('proprietary brep'));
    zip.addFile('FusionAssetName[Active]/Previews/small.png', ONE_PIXEL_PNG);
    zip.writeZip(path.join(filesDir, 'widget.f3d'));
    await runScan();

    const row = db.prepare("SELECT * FROM files WHERE filename = 'widget.f3d'").get() as any;
    expect(row).toBeTruthy();
    expect(row.ext).toBe('.f3d');
    expect(row.thumbnail_path).toBe('thumbnail.png');
    const png = fs.readFileSync(path.join(process.env.ASSETS_DIR!, String(row.id), 'thumbnail.png'));
    expect(png.equals(ONE_PIXEL_PNG)).toBe(true);
    expect(row.mesh_path).toBeNull();
    expect(row.dimension_x).toBeNull();
    expect(row.geometry_hash).toBeNull();
    expect(row.content_hash).toBeTruthy(); // exact-duplicate detection still applies
  });

  it('does not render a thumbnail over a Bambu 3MF that has its own embedded plate image', async () => {
    // writeBambu3mf embeds Metadata/plate_1.png (a real 1×1 PNG). That should win over a
    // synthetic render — assert the cached thumbnail is the tiny embedded one, not a 256px raster.
    writeBambu3mf('embedded-thumb.3mf', ONE_PIXEL_PNG);
    await runScan();
    const row = db.prepare("SELECT * FROM files WHERE filename = 'embedded-thumb.3mf'").get() as any;
    expect(row.thumbnail_path).toBe('thumbnail.png');
    const png = fs.readFileSync(path.join(process.env.ASSETS_DIR!, String(row.id), 'thumbnail.png'));
    expect(png.equals(ONE_PIXEL_PNG)).toBe(true);
  });

  it('backfills a missing thumbnail on rescan of a row stuck at an older scanner_version', async () => {
    writeBinaryStlWithKnownSize('stale-thumb.stl', [15, 15, 15]);
    await runScan();
    const id = (db.prepare("SELECT id FROM files WHERE filename = 'stale-thumb.stl'").get() as any).id;
    fs.rmSync(path.join(process.env.ASSETS_DIR!, String(id), 'thumbnail.png'), { force: true });
    db.prepare('UPDATE files SET thumbnail_path = NULL, scanner_version = 0 WHERE id = ?').run(id);

    await runScan();

    const after = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as any;
    expect(after.thumbnail_path).toBe('thumbnail.png');
    expect(fs.existsSync(path.join(process.env.ASSETS_DIR!, String(id), 'thumbnail.png'))).toBe(true);
  });

  it('backfills filaments_json on a rescan of a row stuck at an older scanner_version', async () => {
    writeBambu3mf('legacy-filaments.3mf');
    await runScan();
    db.prepare(
      "UPDATE files SET filaments_json = NULL, scanner_version = 0 WHERE filename = 'legacy-filaments.3mf'"
    ).run();

    await runScan();

    const after = db
      .prepare("SELECT * FROM files WHERE filename = 'legacy-filaments.3mf'")
      .get() as any;
    expect(JSON.parse(after.filaments_json)).toHaveLength(2);
    expect(after.scanner_version).toBeGreaterThanOrEqual(6);
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

  it('does not flag a whole root missing when its path becomes unreachable', async () => {
    const offlineDir = path.join(tmpRoot, 'offline-root');
    fs.mkdirSync(offlineDir, { recursive: true });
    fs.writeFileSync(path.join(offlineDir, 'a.stl'), 'solid a\nendsolid a\n');
    fs.writeFileSync(path.join(offlineDir, 'b.stl'), 'solid b\nendsolid b\n');
    saveConfig({
      roots: [
        { label: 'Test Root', path: filesDir },
        { label: 'Removable', path: offlineDir },
      ],
    });
    await runScan();
    expect(db.prepare("SELECT COUNT(*) c FROM files f JOIN roots r ON r.id=f.root_id WHERE r.label='Removable'").get()).toEqual({ c: 2 });

    // "Unplug" the drive.
    fs.rmSync(offlineDir, { recursive: true, force: true });
    const result = await runScan();

    const stillThere = db
      .prepare("SELECT missing FROM files f JOIN roots r ON r.id=f.root_id WHERE r.label='Removable'")
      .all() as { missing: number }[];
    expect(stillThere).toHaveLength(2);
    expect(stillThere.every((r) => r.missing === 0)).toBe(true);
    expect(result.missing).toBe(0);

    saveConfig({ roots: [{ label: 'Test Root', path: filesDir }] });
    await runScan();
  });

  it('follows a symlinked subdirectory', async () => {
    const realDir = path.join(tmpRoot, 'linked-target');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'via-symlink.stl'), 'solid s\nendsolid s\n');
    try {
      fs.symlinkSync(realDir, path.join(filesDir, 'linked'), 'junction');
    } catch {
      return; // no permission to create links on this box — skip
    }

    await runScan();
    expect(db.prepare('SELECT id FROM files WHERE filename = ?').get('via-symlink.stl')).toBeTruthy();

    fs.rmSync(path.join(filesDir, 'linked'), { recursive: true, force: true });
    await runScan();
  });
});

describe('scan progress, cancel and reprocess modes', () => {
  it('exposes progress: idle before, running/processing during, done after', async () => {
    writeStl('progress-1.stl');
    writeStl('progress-2.stl');

    expect(getScanProgress().running).toBe(false);

    let sawRunning = false;
    const scan = runScan();
    // The scan yields to the loop between files, so a poll here catches it mid-flight.
    for (let i = 0; i < 50 && !sawRunning; i++) {
      const p = getScanProgress();
      if (p.running && p.phase === 'processing') sawRunning = true;
      await new Promise((r) => setTimeout(r, 2));
    }
    const result = await scan;

    expect(sawRunning).toBe(true);
    expect(result.cancelled).toBe(false);
    const after = getScanProgress();
    expect(after.running).toBe(false);
    expect(after.phase).toBe('done');
    expect(after.total).toBeGreaterThanOrEqual(2);
    expect(after.processed).toBe(after.total);
  });

  it('reprocess-stale re-runs processing on version-behind rows without a filesystem walk', async () => {
    writeStl('reproc.stl');
    await runScan();
    const row = db.prepare("SELECT id FROM files WHERE filename = 'reproc.stl'").get() as { id: number };

    // Simulate a scanner-version bump: knock the row back and null its derived data.
    db.prepare(
      'UPDATE files SET scanner_version = 0, content_hash = NULL, geometry_hash = NULL WHERE id = ?'
    ).run(row.id);
    expect(pendingReprocessCount()).toBeGreaterThanOrEqual(1);

    const result = await runScan({ mode: 'reprocess-stale' });
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.added).toBe(0);
    expect(result.missing).toBe(0);

    const reprocessed = db
      .prepare("SELECT content_hash, scanner_version FROM files WHERE id = ?")
      .get(row.id) as { content_hash: string | null; scanner_version: number };
    expect(reprocessed.content_hash).toBeTruthy();
    expect(pendingReprocessCount()).toBe(0);
  });

  it('reprocess-stale flags a row whose file vanished, and leaves present ones alone', async () => {
    writeStl('reproc-gone.stl');
    writeStl('reproc-stays.stl');
    await runScan();
    // Only knock these two back to stale so the assertion is independent of what other tests left.
    db.prepare(
      "UPDATE files SET scanner_version = 0 WHERE filename IN ('reproc-gone.stl', 'reproc-stays.stl')"
    ).run();

    fs.unlinkSync(path.join(filesDir, 'reproc-gone.stl'));
    const result = await runScan({ mode: 'reprocess-stale' });

    expect((db.prepare("SELECT missing FROM files WHERE filename = 'reproc-gone.stl'").get() as any).missing).toBe(1);
    expect((db.prepare("SELECT missing FROM files WHERE filename = 'reproc-stays.stl'").get() as any).missing).toBe(0);
    expect(result.missing).toBeGreaterThanOrEqual(1);

    writeStl('reproc-gone.stl');
    await runScan();
  });
});
