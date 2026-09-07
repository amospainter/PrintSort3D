import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { listArchiveModelEntries, readArchiveEntry, readArchiveModelEntry } from './archive';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    fs.rmSync(f, { force: true });
  }
});

function writeFixtureZip(entries: { name: string; content: Buffer | string }[]): string {
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content));
  }
  const filePath = path.join(os.tmpdir(), `archive-test-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  zip.writeZip(filePath);
  tmpFiles.push(filePath);
  return filePath;
}

describe('listArchiveModelEntries', () => {
  it('lists only 3D model files, ignoring everything else', () => {
    const file = writeFixtureZip([
      { name: 'Models/widget.stl', content: 'stl-bytes' },
      { name: 'Models/gadget.3mf', content: 'threemf-bytes' },
      { name: 'readme.txt', content: 'not a model' },
      { name: 'Models/part.obj', content: 'obj-bytes' },
    ]);

    const entries = listArchiveModelEntries(file);

    expect(entries.map((e) => e.path).sort()).toEqual(['Models/gadget.3mf', 'Models/part.obj', 'Models/widget.stl']);
    expect(entries.find((e) => e.path === 'Models/widget.stl')?.ext).toBe('.stl');
  });

  it('returns an empty list for an archive with no model files', () => {
    const file = writeFixtureZip([{ name: 'readme.txt', content: 'hello' }]);
    expect(listArchiveModelEntries(file)).toEqual([]);
  });

  it('does not throw on a non-zip / corrupt file', () => {
    const filePath = path.join(os.tmpdir(), `corrupt-archive-${Date.now()}.zip`);
    fs.writeFileSync(filePath, 'not a zip file');
    tmpFiles.push(filePath);

    expect(listArchiveModelEntries(filePath)).toEqual([]);
  });
});

describe('readArchiveEntry', () => {
  it('reads the raw bytes of one entry', () => {
    const content = Buffer.from('the actual stl content');
    const file = writeFixtureZip([{ name: 'Models/widget.stl', content }]);

    expect(readArchiveEntry(file, 'Models/widget.stl')).toEqual(content);
  });

  it('returns null for an entry that does not exist', () => {
    const file = writeFixtureZip([{ name: 'Models/widget.stl', content: 'x' }]);
    expect(readArchiveEntry(file, 'Models/missing.stl')).toBeNull();
  });

  it('returns null for a non-zip / corrupt file', () => {
    const filePath = path.join(os.tmpdir(), `corrupt-archive-read-${Date.now()}.zip`);
    fs.writeFileSync(filePath, 'not a zip file');
    tmpFiles.push(filePath);

    expect(readArchiveEntry(filePath, 'anything')).toBeNull();
  });
});

describe('readArchiveModelEntry', () => {
  it('reads a model entry in one archive open', () => {
    const content = Buffer.from('stl payload');
    const file = writeFixtureZip([
      { name: 'Models/widget.stl', content },
      { name: 'readme.txt', content: 'ignored' },
    ]);
    expect(readArchiveModelEntry(file, 'Models/widget.stl')).toEqual(content);
  });

  it('returns null for a non-model entry, a missing entry, and a corrupt zip', () => {
    const file = writeFixtureZip([
      { name: 'Models/widget.stl', content: 'x' },
      { name: 'notes.txt', content: 'y' },
    ]);
    expect(readArchiveModelEntry(file, 'notes.txt')).toBeNull();
    expect(readArchiveModelEntry(file, 'Models/nope.stl')).toBeNull();

    const bad = path.join(os.tmpdir(), `corrupt-model-entry-${Date.now()}.zip`);
    fs.writeFileSync(bad, 'not a zip');
    tmpFiles.push(bad);
    expect(readArchiveModelEntry(bad, 'anything')).toBeNull();
  });
});
