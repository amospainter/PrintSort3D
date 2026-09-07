import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let extractArtifactsPooled: typeof import('./scanPool').extractArtifactsPooled;
let extractArtifacts: typeof import('./scanArtifacts').extractArtifacts;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scanpool-test-'));
  process.env.ASSETS_DIR = path.join(tmpRoot, 'assets');
  delete process.env.SCAN_WORKERS; // exercise the inline fallback the test suite relies on
  ({ extractArtifactsPooled } = await import('./scanPool'));
  ({ extractArtifacts } = await import('./scanArtifacts'));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* windows lock */
  }
});

const ASCII_STL =
  'solid x\nfacet normal 0 0 1\nouter loop\n' +
  'vertex 0 0 0\nvertex 12 0 0\nvertex 0 7 0\nendloop\nendfacet\nendsolid x\n';

describe('extractArtifactsPooled (workers disabled)', () => {
  it('runs inline and returns the same artifacts as extractArtifacts', async () => {
    const stl = path.join(tmpRoot, 'part.stl');
    fs.writeFileSync(stl, ASCII_STL);

    const [pooled, inline] = await Promise.all([
      extractArtifactsPooled(1, stl, '.stl'),
      extractArtifacts(2, stl, '.stl'),
    ]);

    expect(pooled.dimensions).toEqual({ x: 12, y: 7, z: 0 });
    expect(pooled.dimensions).toEqual(inline.dimensions);
    expect(pooled.geometryHash).toBe(inline.geometryHash);
    expect(pooled.meshCached).toBe(true);
    expect(pooled.thumbnailWritten).toBe(true);
    expect(pooled.threeMf).toBeNull();
    expect(pooled.archiveEntryCount).toBeNull();
  });

  it('returns null geometry/dimensions for a file with no parseable mesh', async () => {
    const empty = path.join(tmpRoot, 'empty.stl');
    fs.writeFileSync(empty, 'solid x\nendsolid x\n');
    const a = await extractArtifactsPooled(3, empty, '.stl');
    expect(a.dimensions).toBeNull();
    expect(a.geometryHash).toBeNull();
    expect(a.meshCached).toBe(false);
    expect(a.contentHash).toBeTruthy(); // raw-bytes hash still computed
  });
});
