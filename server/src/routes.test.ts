import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import request from 'supertest';
import type { Express } from 'express';
import AdmZip from 'adm-zip';

let tmpRoot: string;
let filesDir: string;
let db: typeof import('./db').db;
let runScan: typeof import('./scanner').runScan;
let saveConfig: typeof import('./config').saveConfig;
let createApp: typeof import('./app').createApp;
let app: Express;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-routes-test-'));
  filesDir = path.join(tmpRoot, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  process.env.DB_PATH = path.join(tmpRoot, 'test.db');
  process.env.CONFIG_PATH = path.join(tmpRoot, 'config.json');
  process.env.ASSETS_DIR = path.join(tmpRoot, 'assets');
  fs.mkdirSync(process.env.ASSETS_DIR, { recursive: true });

  ({ db } = await import('./db'));
  ({ saveConfig } = await import('./config'));
  ({ runScan } = await import('./scanner'));
  ({ createApp } = await import('./app'));

  fs.writeFileSync(path.join(filesDir, 'widget.stl'), 'solid x\nendsolid x\n');

  // A binary STL with real geometry, used to assert the `dimensions` field is populated.
  const sizedStl = Buffer.alloc(84 + 50);
  sizedStl.writeUInt32LE(1, 80);
  const vertices: [number, number, number][] = [
    [0, 0, 0],
    [20, 0, 0],
    [0, 6, 3],
  ];
  let offset = 84 + 12;
  for (const [x, y, z] of vertices) {
    sizedStl.writeFloatLE(x, offset);
    sizedStl.writeFloatLE(y, offset + 4);
    sizedStl.writeFloatLE(z, offset + 8);
    offset += 12;
  }
  fs.writeFileSync(path.join(filesDir, 'sized.stl'), sizedStl);

  saveConfig({ roots: [{ label: 'Test Root', path: filesDir }] });
  await runScan();

  app = createApp();
});

afterAll(() => {
  db.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold a lock on the just-closed db file.
  }
});

describe('files routes', () => {
  it('lists scanned files inside a paginated envelope', async () => {
    const res = await request(app).get('/api/files?query=widget');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].filename).toBe('widget.stl');
    expect(res.body.items[0].tags).toEqual([]);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.totalPages).toBe(1);
  });

  it('filters by filename query', async () => {
    const hit = await request(app).get('/api/files?query=widget');
    expect(hit.body.items).toHaveLength(1);
    expect(hit.body.total).toBe(1);

    const miss = await request(app).get('/api/files?query=nonexistent');
    expect(miss.body.items).toHaveLength(0);
    expect(miss.body.total).toBe(0);
  });

  it('filters by root label', async () => {
    const hit = await request(app).get(`/api/files?root=${encodeURIComponent('Test Root')}&query=widget`);
    expect(hit.body.items).toHaveLength(1);

    const miss = await request(app).get(`/api/files?root=${encodeURIComponent('Nonexistent Root')}`);
    expect(miss.body.items).toHaveLength(0);
  });

  it('returns null dimensions for a file with no parseable geometry, and populated dimensions for one that has it', async () => {
    const widget = (await request(app).get('/api/files?query=widget')).body.items[0];
    expect(widget.dimensions).toBeNull();

    const sized = (await request(app).get('/api/files?query=sized')).body.items[0];
    expect(sized.dimensions.x).toBeCloseTo(20);
    expect(sized.dimensions.y).toBeCloseTo(6);
    expect(sized.dimensions.z).toBeCloseTo(3);
  });

  it('404s for an unknown file id', async () => {
    const res = await request(app).get('/api/files/99999');
    expect(res.status).toBe(404);
  });

  it('updates notes and tags, lowercasing and deduping tag names', async () => {
    const fileId = (await request(app).get('/api/files')).body.items[0].id;

    const res = await request(app)
      .patch(`/api/files/${fileId}`)
      .send({ notes: 'printed twice', tags: ['Calibration', 'calibration', ' Test '] });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('printed twice');
    expect(res.body.tags.sort()).toEqual(['calibration', 'test']);
  });

  it('lists all distinct tags with color and usage count', async () => {
    const res = await request(app).get('/api/tags');
    expect(res.status).toBe(200);
    expect(res.body.map((t: { name: string }) => t.name).sort()).toEqual(['calibration', 'test']);
    expect(res.body.every((t: { color: unknown; count: number }) => t.color === null && t.count >= 1)).toBe(true);
  });

  it('sets and clears a tag color, and rejects a bad hex value', async () => {
    const ok = await request(app).patch('/api/tags/calibration').send({ color: '#4a90e2' });
    expect(ok.status).toBe(200);
    expect(ok.body.color).toBe('#4a90e2');

    const bad = await request(app).patch('/api/tags/calibration').send({ color: 'blue' });
    expect(bad.status).toBe(400);

    const cleared = await request(app).patch('/api/tags/calibration').send({ color: null });
    expect(cleared.body.color).toBeNull();
  });

  it('exposes and updates the default plate size', async () => {
    const initial = await request(app).get('/api/settings');
    expect(initial.body.defaultPlateSize).toEqual({ x: 256, y: 256 });

    const updated = await request(app).put('/api/settings').send({ defaultPlateSize: { x: 300, y: 300 } });
    expect(updated.status).toBe(200);
    expect(updated.body.defaultPlateSize).toEqual({ x: 300, y: 300 });

    const bad = await request(app).put('/api/settings').send({ defaultPlateSize: { x: 0, y: 300 } });
    expect(bad.status).toBe(400);
  });

  it('404s when patching an unknown file id', async () => {
    const res = await request(app).patch('/api/files/99999').send({ notes: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('tag filtering', () => {
  it('AND-matches: a file must carry every listed tag, not just one of them', async () => {
    fs.writeFileSync(path.join(filesDir, 'tag-both.stl'), 'solid tag-both\nendsolid tag-both\n');
    fs.writeFileSync(path.join(filesDir, 'tag-red-only.stl'), 'solid tag-red-only\nendsolid tag-red-only\n');
    fs.writeFileSync(path.join(filesDir, 'tag-vase-only.stl'), 'solid tag-vase-only\nendsolid tag-vase-only\n');
    await runScan();

    const [both, redOnly, vaseOnly] = await Promise.all(
      ['tag-both', 'tag-red-only', 'tag-vase-only'].map(async (name) => {
        const res = await request(app).get(`/api/files?query=${name}`);
        return res.body.items[0].id as number;
      })
    );
    await request(app).patch(`/api/files/${both}`).send({ tags: ['red', 'vase'] });
    await request(app).patch(`/api/files/${redOnly}`).send({ tags: ['red'] });
    await request(app).patch(`/api/files/${vaseOnly}`).send({ tags: ['vase'] });

    const res = await request(app).get('/api/files?tags=red,vase');
    expect(res.body.items.map((f: any) => f.id)).toEqual([both]);
  });
});

describe('files pagination', () => {
  it('paginates results according to page and pageSize', async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(filesDir, `page-test-${i}.stl`), 'solid x\nendsolid x\n');
    }
    await runScan();

    const page1 = await request(app).get('/api/files?pageSize=2&page=1&sort=name');
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBeGreaterThanOrEqual(6);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(2);
    expect(page1.body.totalPages).toBeGreaterThanOrEqual(3);

    const page2 = await request(app).get('/api/files?pageSize=2&page=2&sort=name');
    expect(page2.body.items).toHaveLength(2);
    const page1Ids = page1.body.items.map((f: any) => f.id);
    const page2Ids = page2.body.items.map((f: any) => f.id);
    expect(page1Ids.some((id: number) => page2Ids.includes(id))).toBe(false);
  });

  it('returns an empty items array for a page past the end', async () => {
    const res = await request(app).get('/api/files?pageSize=2&page=999');
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('clamps pageSize to the configured maximum', async () => {
    const res = await request(app).get('/api/files?pageSize=99999');
    expect(res.body.pageSize).toBe(200);
  });
});

describe('folder routes', () => {
  beforeAll(async () => {
    const nested = path.join(filesDir, 'vehicles', 'cars');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(filesDir, 'vehicles', 'boat.stl'), 'solid x\nendsolid x\n');
    fs.writeFileSync(path.join(nested, 'sedan.stl'), 'solid x\nendsolid x\n');
    fs.writeFileSync(path.join(nested, 'coupe.stl'), 'solid x\nendsolid x\n');
    await runScan();
  });

  it('lists every ancestor directory with a recursive file count', async () => {
    const res = await request(app).get('/api/folders');
    expect(res.status).toBe(200);
    const byPath = Object.fromEntries(res.body.map((f: any) => [f.path, f]));
    expect(byPath['vehicles'].fileCount).toBe(3);
    expect(byPath['vehicles'].root).toBe('Test Root');
    expect(byPath['vehicles/cars'].fileCount).toBe(2);
    expect(byPath['vehicles/cars'].name).toBe('cars');
  });

  it('filters files to a folder and its descendants', async () => {
    const nested = await request(app).get('/api/files?folder=vehicles/cars&sort=name');
    expect(nested.body.items.map((f: any) => f.filename).sort()).toEqual(['coupe.stl', 'sedan.stl']);

    const parent = await request(app).get('/api/files?folder=vehicles');
    expect(parent.body.total).toBe(3);
  });
});

describe('thumbnail routes', () => {
  it('accepts an uploaded thumbnail and serves it back', async () => {
    const fileId = (await request(app).get('/api/files')).body.items[0].id;
    const onePixelPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const upload = await request(app).post(`/api/files/${fileId}/thumbnail`).send({ imageBase64: onePixelPng });
    expect(upload.status).toBe(200);

    const fileRes = await request(app).get(`/api/files/${fileId}`);
    expect(fileRes.body.thumbnailUrl).toBe(`/api/files/${fileId}/thumbnail`);

    const imgRes = await request(app).get(`/api/files/${fileId}/thumbnail`);
    expect(imgRes.status).toBe(200);
  });

  it('returns 404 for a file with no cached thumbnail', async () => {
    const res = await request(app).get('/api/files/99999/thumbnail');
    expect(res.status).toBe(404);
  });
});

describe('raw file route', () => {
  it('streams the real file for a valid record', async () => {
    const fileId = (await request(app).get('/api/files?query=widget')).body.items[0].id;
    const res = await request(app).get(`/api/raw/${fileId}`);
    expect(res.status).toBe(200);
  });

  it('blocks a record whose relative_path escapes its root', async () => {
    const fileId = (await request(app).get('/api/files?query=widget')).body.items[0].id;
    db.prepare('UPDATE files SET relative_path = ? WHERE id = ?').run('../../outside.stl', fileId);

    const res = await request(app).get(`/api/raw/${fileId}`);
    expect(res.status).toBe(400);

    db.prepare('UPDATE files SET relative_path = ? WHERE id = ?').run('widget.stl', fileId);
  });

  it('404s for an unknown file id', async () => {
    const res = await request(app).get('/api/raw/99999');
    expect(res.status).toBe(404);
  });
});

describe('embedded 3mf images / asset routes', () => {
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );

  it('exposes cached embedded images as /api/assets URLs and serves them', async () => {
    const zip = new AdmZip();
    zip.addFile('Metadata/plate_1.png', onePixelPng);
    zip.addFile('Metadata/top_1.png', onePixelPng);
    zip.writeZip(path.join(filesDir, 'gallery.3mf'));
    await runScan();

    const fileRes = await request(app).get('/api/files?query=gallery');
    const file = fileRes.body.items[0];
    expect(file.embeddedImages.length).toBeGreaterThanOrEqual(2);
    expect(file.embeddedImages.every((url: string) => url.startsWith(`/api/assets/${file.id}/`))).toBe(true);

    const imgRes = await request(app).get(file.embeddedImages[0]);
    expect(imgRes.status).toBe(200);
  });

  it('serves the baked mesh at /api/files/:id/mesh (gzip) and sets file.meshUrl', async () => {
    const zip = new AdmZip();
    zip.addFile('Metadata/plate_1.png', onePixelPng);
    zip.addFile(
      '3D/3dmodel.model',
      Buffer.from(
        '<model><resources><object id="1"><mesh><vertices>' +
          '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>' +
          '</vertices><triangles>' +
          '<triangle v1="0" v2="1" v3="2" paint_color="8"/>' +
          '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
      )
    );
    zip.writeZip(path.join(filesDir, 'baked.3mf'));
    await runScan();

    const listRes = await request(app).get('/api/files?query=baked');
    const file = listRes.body.items[0];
    expect(file.meshUrl).toBe(`/api/files/${file.id}/mesh`);

    const meshRes = await request(app)
      .get(file.meshUrl)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(meshRes.status).toBe(200);
    expect(meshRes.headers['content-encoding']).toBe('gzip');
    // superagent may or may not have already inflated the body; handle both.
    let blob = meshRes.body as Buffer;
    if (blob[0] === 0x1f && blob[1] === 0x8b) blob = zlib.gunzipSync(blob);
    expect(blob.toString('ascii', 0, 4)).toBe('PSM1');
    expect(blob.readUInt32LE(4)).toBe(1); // one part
    expect(blob.readUInt32LE(12)).toBe(3); // indexCount = 1 triangle
  });

  it('404s /api/files/:id/mesh for a file with no baked mesh', async () => {
    fs.writeFileSync(path.join(filesDir, 'nogeo.stl'), 'solid x\nendsolid x\n');
    await runScan();
    const listRes = await request(app).get('/api/files?query=nogeo');
    const file = listRes.body.items[0];
    expect(file.meshUrl).toBeNull();
    const res = await request(app).get(`/api/files/${file.id}/mesh`);
    expect(res.status).toBe(404);
  });

  it('serializes the multi-color filament list as file.filaments', async () => {
    const zip = new AdmZip();
    zip.addFile('Metadata/plate_1.png', onePixelPng);
    zip.addFile(
      'Metadata/project_settings.config',
      Buffer.from(
        JSON.stringify({ filament_type: ['PLA', 'PETG'], filament_colour: ['#AABBCC', '#112233'] })
      )
    );
    zip.writeZip(path.join(filesDir, 'filaments.3mf'));
    await runScan();

    const res = await request(app).get('/api/files?query=filaments');
    expect(res.body.items[0].filaments).toEqual([
      { color: '#AABBCC', type: 'PLA' },
      { color: '#112233', type: 'PETG' },
    ]);
  });

  it('rejects non-webp / path-traversal-looking asset filenames', async () => {
    const res = await request(app).get('/api/assets/1/../../../etc/passwd');
    expect([400, 404]).toContain(res.status);
  });

  it('404s for an asset filename that does not exist on disk', async () => {
    const res = await request(app).get('/api/assets/1/nonexistent.webp');
    expect(res.status).toBe(404);
  });
});

describe('duplicate detection routes', () => {
  it('reports duplicateCount and a duplicates list for byte-identical files', async () => {
    fs.writeFileSync(path.join(filesDir, 'dup-a.stl'), 'solid dup\nendsolid dup\n');
    fs.writeFileSync(path.join(filesDir, 'dup-b.stl'), 'solid dup\nendsolid dup\n');
    await runScan();

    const listRes = await request(app).get('/api/files?query=dup-');
    const [a, b] = listRes.body.items;
    expect(a.duplicateCount).toBe(1);
    expect(b.duplicateCount).toBe(1);

    const detailRes = await request(app).get(`/api/files/${a.id}`);
    expect(detailRes.body.duplicates).toHaveLength(1);
    expect(detailRes.body.duplicates[0].id).toBe(b.id);
    expect(detailRes.body.duplicates[0].matchType).toBe('exact');
  });

  it('filters to only files with a duplicate when duplicatesOnly=1', async () => {
    const res = await request(app).get('/api/files?duplicatesOnly=1&pageSize=200');
    const filenames = res.body.items.map((f: any) => f.filename);
    expect(filenames).toContain('dup-a.stl');
    expect(filenames).toContain('dup-b.stl');
    // sized.stl's binary content (specific float-encoded vertices) is unique across every
    // fixture in this suite, unlike the placeholder "solid x\nendsolid x\n" text used by
    // several other zero-geometry STL fixtures, which legitimately do hash-match each other.
    expect(filenames).not.toContain('sized.stl');
  });

  it('reports no duplicates for a file with unique content', async () => {
    const res = await request(app).get('/api/files?query=sized');
    expect(res.body.items[0].duplicateCount).toBe(0);
  });
});

describe('archive routes', () => {
  it('lists the model entries inside a scanned zip', async () => {
    const zip = new AdmZip();
    zip.addFile('Models/one.stl', Buffer.from('solid one\nendsolid one\n'));
    zip.addFile('Models/two.obj', Buffer.from('v 0 0 0\n'));
    zip.addFile('readme.txt', Buffer.from('not a model'));
    zip.writeZip(path.join(filesDir, 'bundle.zip'));
    await runScan();

    const fileRes = await request(app).get('/api/files?query=bundle');
    const zipFile = fileRes.body.items[0];
    expect(zipFile.archiveEntryCount).toBe(2);

    const archiveRes = await request(app).get(`/api/files/${zipFile.id}/archive`);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.map((e: any) => e.path).sort()).toEqual(['Models/one.stl', 'Models/two.obj']);
  });

  it('streams the raw bytes of one archive entry', async () => {
    const fileRes = await request(app).get('/api/files?query=bundle');
    const zipFile = fileRes.body.items[0];

    const res = await request(app).get(`/api/files/${zipFile.id}/archive-raw?path=Models/one.stl`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toContain('solid one');
  });

  it('404s for an archive-raw path that was not enumerated', async () => {
    const fileRes = await request(app).get('/api/files?query=bundle');
    const zipFile = fileRes.body.items[0];

    const res = await request(app).get(`/api/files/${zipFile.id}/archive-raw?path=../../etc/passwd`);
    expect(res.status).toBe(404);
  });

  it('400s the archive endpoints for a non-zip file', async () => {
    const widget = (await request(app).get('/api/files?query=widget')).body.items[0];

    const listRes = await request(app).get(`/api/files/${widget.id}/archive`);
    expect(listRes.status).toBe(400);

    const rawRes = await request(app).get(`/api/files/${widget.id}/archive-raw?path=x`);
    expect(rawRes.status).toBe(400);
  });
});

describe('rescan route', () => {
  it('reprocesses a single file on demand and returns the refreshed record', async () => {
    const rescanPath = path.join(filesDir, 'rescan-me.stl');
    fs.writeFileSync(rescanPath, 'solid rescan-me\nendsolid rescan-me\n');
    await runScan();

    const before = (await request(app).get('/api/files?query=rescan-me')).body.items[0];
    expect(before.contentHash).toBeTruthy();

    const res = await request(app).post(`/api/files/${before.id}/rescan`);
    expect(res.status).toBe(200);
    expect(res.body.rescanStatus).toBe('ok');
    expect(res.body.filename).toBe('rescan-me.stl');
    expect(res.body.contentHash).toBe(before.contentHash);
    expect(res.body.duplicates).toBeDefined();
  });

  it('flags missing=true and reports rescanStatus "missing" for a file removed from disk', async () => {
    const goneePath = path.join(filesDir, 'gone.stl');
    fs.writeFileSync(goneePath, 'solid gone\nendsolid gone\n');
    await runScan();
    const before = (await request(app).get('/api/files?query=gone')).body.items[0];

    fs.rmSync(goneePath);
    const res = await request(app).post(`/api/files/${before.id}/rescan`);
    expect(res.status).toBe(200);
    expect(res.body.rescanStatus).toBe('missing');
    expect(res.body.missing).toBe(true);
  });

  it('404s for an id that does not exist', async () => {
    const res = await request(app).post('/api/files/999999/rescan');
    expect(res.status).toBe(404);
  });
});

describe('roots routes', () => {
  it('reads back the configured roots', async () => {
    const res = await request(app).get('/api/roots');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ label: 'Test Root', path: filesDir }]);
  });

  it('rejects a non-array body', async () => {
    const res = await request(app).put('/api/roots').send({ not: 'an array' });
    expect(res.status).toBe(400);
  });

  it('deletes catalog entries for a root that gets removed from the list', async () => {
    const removableDir = path.join(tmpRoot, 'removable');
    fs.mkdirSync(removableDir, { recursive: true });
    fs.writeFileSync(path.join(removableDir, 'temp.stl'), 'solid x\nendsolid x\n');

    await request(app)
      .put('/api/roots')
      .send([
        { label: 'Test Root', path: filesDir },
        { label: 'Removable Root', path: removableDir },
      ]);
    await runScan();

    const beforeRemoval = await request(app).get('/api/files?pageSize=200');
    expect(beforeRemoval.body.items.some((f: any) => f.filename === 'temp.stl')).toBe(true);

    const putRes = await request(app).put('/api/roots').send([{ label: 'Test Root', path: filesDir }]);
    expect(putRes.status).toBe(200);

    const afterRemoval = await request(app).get('/api/files?pageSize=200');
    expect(afterRemoval.body.items.some((f: any) => f.filename === 'temp.stl')).toBe(false);
    expect(afterRemoval.body.items.some((f: any) => f.filename === 'widget.stl')).toBe(true);

    const rootsRes = await request(app).get('/api/roots');
    expect(rootsRes.body.some((r: any) => r.label === 'Removable Root')).toBe(false);

    const orphanedRootRow = db.prepare('SELECT id FROM roots WHERE label = ?').get('Removable Root');
    expect(orphanedRootRow).toBeUndefined();
  });
});

describe('scan route scoping', () => {
  it('scans only the named root and 404s for an unknown one', async () => {
    const scopedDir = path.join(tmpRoot, 'scoped-scan');
    fs.mkdirSync(scopedDir, { recursive: true });
    fs.writeFileSync(path.join(scopedDir, 'scoped.stl'), 'solid x\nendsolid x\n');
    await request(app)
      .put('/api/roots')
      .send([
        { label: 'Test Root', path: filesDir },
        { label: 'Scoped Root', path: scopedDir },
      ]);

    const scoped = await request(app).post('/api/scan').send({ root: 'Scoped Root' });
    expect(scoped.status).toBe(200);
    expect(scoped.body.added).toBe(1);

    const unknown = await request(app).post('/api/scan').send({ root: 'Nope' });
    expect(unknown.status).toBe(404);

    await request(app).put('/api/roots').send([{ label: 'Test Root', path: filesDir }]);
  });
});
