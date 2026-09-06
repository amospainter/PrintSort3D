import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { frameObject, loadModelAsObject3D } from './loadModel';

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
