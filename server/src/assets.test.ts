import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

let tmpRoot: string;
let cacheThreeMfImages: typeof import('./assets').cacheThreeMfImages;
let deleteCachedImages: typeof import('./assets').deleteCachedImages;

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-assets-test-'));
  process.env.ASSETS_DIR = path.join(tmpRoot, 'assets');
  ({ cacheThreeMfImages, deleteCachedImages } = await import('./assets'));
});

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    fs.rmSync(f, { force: true });
  }
});

function writeFixture3mf(entries: { name: string; content: Buffer | string }[]): string {
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content));
  }
  const filePath = path.join(os.tmpdir(), `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.3mf`);
  zip.writeZip(filePath);
  tmpFiles.push(filePath);
  return filePath;
}

describe('cacheThreeMfImages', () => {
  it('converts each embedded image to webp and caches it under ASSETS_DIR/<fileId>/', async () => {
    const file = writeFixture3mf([
      { name: 'Metadata/plate_1.png', content: ONE_PIXEL_PNG },
      { name: 'Metadata/top_1.png', content: ONE_PIXEL_PNG },
    ]);

    const names = await cacheThreeMfImages(101, file);

    expect(names.sort()).toEqual(['plate_1.webp', 'top_1.webp']);
    for (const name of names) {
      const outPath = path.join(process.env.ASSETS_DIR!, '101', name);
      expect(fs.existsSync(outPath)).toBe(true);
      const buf = fs.readFileSync(outPath);
      expect(buf.subarray(8, 12).toString('ascii')).toBe('WEBP');
    }
  });

  it('skips images that fail to decode instead of throwing', async () => {
    const file = writeFixture3mf([{ name: 'Metadata/plate_1.png', content: 'not actually a png' }]);

    const names = await cacheThreeMfImages(102, file);

    expect(names).toEqual([]);
  });

  it('returns an empty array for a 3mf with no embedded images', async () => {
    const file = writeFixture3mf([{ name: 'Metadata/project_settings.config', content: '{}' }]);
    const names = await cacheThreeMfImages(103, file);
    expect(names).toEqual([]);
  });
});

describe('deleteCachedImages', () => {
  it('removes a file id directory tree', async () => {
    const file = writeFixture3mf([{ name: 'Metadata/plate_1.png', content: ONE_PIXEL_PNG }]);
    await cacheThreeMfImages(104, file);
    const dir = path.join(process.env.ASSETS_DIR!, '104');
    expect(fs.existsSync(dir)).toBe(true);

    deleteCachedImages(104);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('does not throw when the directory does not exist', () => {
    expect(() => deleteCachedImages(999999)).not.toThrow();
  });
});
