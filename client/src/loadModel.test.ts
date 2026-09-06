import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  frameObject,
  loadModelAsObject3D,
  parseBakedMesh,
  loadBakedMesh,
  applyPaintColors,
  removePaintColors,
} from './loadModel';

// A "PSM1" blob with a single indexed part; `paint` (optional) is one byte per triangle.
function bakedBlob(positions: number[], indices: number[], paint?: number[]): ArrayBuffer {
  const triCount = indices.length / 3;
  const paintBytes = paint ? (triCount + 3) & ~3 : 0;
  const buf = new ArrayBuffer(8 + 12 + positions.length * 4 + indices.length * 4 + paintBytes);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x314d5350, true); // "PSM1"
  dv.setUint32(4, 1, true); // partCount
  dv.setUint32(8, positions.length, true); // floatCount
  dv.setUint32(12, indices.length, true); // indexCount
  dv.setUint32(16, paint ? 1 : 0, true); // flags
  let off = 20;
  positions.forEach((v) => (dv.setFloat32(off, v, true), (off += 4)));
  indices.forEach((v) => (dv.setUint32(off, v, true), (off += 4)));
  if (paint) new Uint8Array(buf, off).set(paint);
  return buf;
}

const SQUARE_POS = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
const SQUARE_IDX = [0, 1, 2, 1, 3, 2];

const ASCII_CUBE_STL = `solid cube
facet normal 0 0 -1
  outer loop
    vertex 0 0 0
    vertex 0 10 0
    vertex 10 10 0
  endloop
endfacet
facet normal 0 0 -1
  outer loop
    vertex 0 0 0
    vertex 10 10 0
    vertex 10 0 0
  endloop
endfacet
endsolid cube
`;

function bufferFrom(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('frameObject', () => {
  it('recenters the object so its bounding-box center sits at the origin', () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(10, 20, 30);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    frameObject(mesh, camera);

    expect(mesh.position.x).toBeCloseTo(0);
    expect(mesh.position.y).toBeCloseTo(0);
    expect(mesh.position.z).toBeCloseTo(0);
  });

  it('positions the camera further away for larger objects', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

    const small = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    frameObject(small, camera);
    const smallDistance = camera.position.length();

    const big = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100));
    frameObject(big, camera);
    const bigDistance = camera.position.length();

    expect(bigDistance).toBeGreaterThan(smallDistance);
  });

  it('sets near/far planes that bracket the camera distance and keep near > 0', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5));

    frameObject(mesh, camera);

    expect(camera.near).toBeGreaterThan(0);
    expect(camera.far).toBeGreaterThan(camera.near);
  });

  it('falls back to a default size for a zero-volume (single-point) object', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const point = new THREE.Object3D();

    expect(() => frameObject(point, camera)).not.toThrow();
    expect(camera.position.length()).toBeGreaterThan(0);
  });
});

describe('parseBakedMesh / loadBakedMesh', () => {
  it('parses a PSM1 part into positions, indices and paint', () => {
    const parts = parseBakedMesh(bakedBlob(SQUARE_POS, SQUARE_IDX, [1, 0]));
    expect(parts).toHaveLength(1);
    expect(Array.from(parts[0].positions)).toEqual(SQUARE_POS);
    expect(Array.from(parts[0].indices)).toEqual(SQUARE_IDX);
    expect(Array.from(parts[0].paint!)).toEqual([1, 0]);
  });

  it('returns [] for a blob without the magic', () => {
    expect(parseBakedMesh(new ArrayBuffer(24))).toEqual([]);
  });

  it('builds a Group with one indexed Mesh per part, paint stashed on userData', () => {
    const group = loadBakedMesh(bakedBlob(SQUARE_POS, SQUARE_IDX, [1, 0]));
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children).toHaveLength(1);
    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh.geometry.getIndex()!.count).toBe(6);
    expect(mesh.geometry.getAttribute('position').count).toBe(4);
    expect((mesh.material as THREE.MeshStandardMaterial).flatShading).toBe(true);
    expect(Array.from(mesh.userData.paint as Uint8Array)).toEqual([1, 0]);
  });

  it('leaves userData.paint null for an unpainted part', () => {
    const group = loadBakedMesh(bakedBlob(SQUARE_POS, SQUARE_IDX));
    expect((group.children[0] as THREE.Mesh).userData.paint).toBeNull();
  });
});

describe('applyPaintColors / removePaintColors', () => {
  it('lays filament colours onto each triangle as a normalized vertex-colour attribute', () => {
    const group = loadBakedMesh(bakedBlob(SQUARE_POS, SQUARE_IDX, [1, 0]));
    const mesh = group.children[0] as THREE.Mesh;
    const originalGeom = mesh.geometry;

    const ok = applyPaintColors(group, ['#ff0000', '#00ff00']);

    expect(ok).toBe(true);
    const color = mesh.geometry.getAttribute('color');
    expect(color.normalized).toBe(true);
    expect(color.count).toBe(6); // 2 triangles × 3 verts, non-indexed
    expect([color.getX(0), color.getY(0), color.getZ(0)]).toEqual([0, 1, 0]); // tri 0 → green
    expect([color.getX(3), color.getY(3), color.getZ(3)]).toEqual([1, 0, 0]); // tri 1 → red
    expect((mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);

    removePaintColors(group);
    expect(mesh.geometry).toBe(originalGeom);
  });

  it('is a no-op (returns false) when no mesh carries paint data', () => {
    const group = loadBakedMesh(bakedBlob(SQUARE_POS, SQUARE_IDX));
    expect(applyPaintColors(group, ['#ffffff'])).toBe(false);
  });
});

describe('loadModelAsObject3D', () => {
  it('parses an ASCII STL into a Mesh', async () => {
    const object = await loadModelAsObject3D('.stl', bufferFrom(ASCII_CUBE_STL));
    expect(object).toBeInstanceOf(THREE.Mesh);
  });

  it('is case-insensitive on the extension', async () => {
    const object = await loadModelAsObject3D('.STL', bufferFrom(ASCII_CUBE_STL));
    expect(object).toBeInstanceOf(THREE.Mesh);
  });

  it('rejects unsupported extensions', async () => {
    await expect(loadModelAsObject3D('.gltf', bufferFrom(''))).rejects.toThrow(/Unsupported model extension/);
  });
});
