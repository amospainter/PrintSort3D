import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeContentHash, computeGeometryHash } from './fingerprint';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    fs.rmSync(f, { force: true });
  }
});

function writeTmp(name: string, content: Buffer | string): string {
  const filePath = path.join(os.tmpdir(), `fingerprint-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  fs.writeFileSync(filePath, content);
  tmpFiles.push(filePath);
  return filePath;
}

function asciiStlWithVertices(vertices: [number, number, number][]): string {
  const lines = ['solid test', 'facet normal 0 0 1', '  outer loop'];
  for (const [x, y, z] of vertices) lines.push(`    vertex ${x} ${y} ${z}`);
  lines.push('  endloop', 'endfacet', 'endsolid test');
  return lines.join('\n') + '\n';
}

describe('computeContentHash', () => {
  it('produces the same hash for byte-identical files', async () => {
    const a = writeTmp('a.stl', 'identical bytes');
    const b = writeTmp('b.stl', 'identical bytes');

    const [hashA, hashB] = await Promise.all([computeContentHash(a), computeContentHash(b)]);

    expect(hashA).toBeTruthy();
    expect(hashA).toBe(hashB);
  });

  it('produces different hashes for different content', async () => {
    const a = writeTmp('a.stl', 'content one');
    const b = writeTmp('b.stl', 'content two');

    const [hashA, hashB] = await Promise.all([computeContentHash(a), computeContentHash(b)]);

    expect(hashA).not.toBe(hashB);
  });

  it('resolves null instead of throwing for a nonexistent file', async () => {
    await expect(computeContentHash('/nonexistent/path/model.stl')).resolves.toBeNull();
  });
});

describe('computeGeometryHash', () => {
  it('produces the same hash for the same geometry with vertices in a different order', () => {
    const a = writeTmp(
      'order-a.stl',
      asciiStlWithVertices([
        [0, 0, 0],
        [10, 0, 0],
        [0, 5, 0],
      ])
    );
    const b = writeTmp(
      'order-b.stl',
      asciiStlWithVertices([
        [0, 5, 0],
        [0, 0, 0],
        [10, 0, 0],
      ])
    );

    expect(computeGeometryHash(a, '.stl')).toBe(computeGeometryHash(b, '.stl'));
  });

  it('produces the same hash for the same geometry translated in space', () => {
    const a = writeTmp(
      'translate-a.stl',
      asciiStlWithVertices([
        [0, 0, 0],
        [10, 0, 0],
        [0, 5, 0],
      ])
    );
    const b = writeTmp(
      'translate-b.stl',
      asciiStlWithVertices([
        [100, 100, 100],
        [110, 100, 100],
        [100, 105, 100],
      ])
    );

    expect(computeGeometryHash(a, '.stl')).toBe(computeGeometryHash(b, '.stl'));
  });

  it('produces a different hash for different geometry', () => {
    const a = writeTmp(
      'diff-a.stl',
      asciiStlWithVertices([
        [0, 0, 0],
        [10, 0, 0],
        [0, 5, 0],
      ])
    );
    const b = writeTmp(
      'diff-b.stl',
      asciiStlWithVertices([
        [0, 0, 0],
        [20, 0, 0],
        [0, 9, 0],
      ])
    );

    expect(computeGeometryHash(a, '.stl')).not.toBe(computeGeometryHash(b, '.stl'));
  });

  it('returns null for a file with no parseable vertex data', () => {
    const file = writeTmp('empty.stl', 'solid x\nendsolid x\n');
    expect(computeGeometryHash(file, '.stl')).toBeNull();
  });

  it('returns null for an unsupported extension', () => {
    const file = writeTmp('model.gltf', '{}');
    expect(computeGeometryHash(file, '.gltf')).toBeNull();
  });
});
