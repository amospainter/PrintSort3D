import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';

export async function loadModelAsObject3D(ext: string, arrayBuffer: ArrayBuffer): Promise<THREE.Object3D> {
  const normalizedExt = ext.toLowerCase();

  if (normalizedExt === '.stl') {
    const loader = new STLLoader();
    const geometry = loader.parse(arrayBuffer);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.6, metalness: 0.1 });
    return new THREE.Mesh(geometry, material);
  }

  if (normalizedExt === '.obj') {
    const text = new TextDecoder().decode(arrayBuffer);
    const loader = new OBJLoader();
    return loader.parse(text);
  }

  if (normalizedExt === '.3mf') {
    const loader = new ThreeMFLoader();
    return loader.parse(arrayBuffer);
  }

  throw new Error(`Unsupported model extension: ${ext}`);
}

// ─── Server-baked render mesh ────────────────────────────────────────────────────────────
//
// For catalogued files the server bakes the model to a compact "PSM1" binary blob at scan
// time (positions + indices, plus per-triangle filament slots for painted 3MFs) — see
// server/src/assets.ts `cacheBakedMesh`. Loading that skips unzipping + DOM-parsing a
// multi-megabyte source file on the browser's main thread.

const MESH_MAGIC = 0x314d5350; // "PSM1" little-endian
// flatShading derives face normals in the shader — no per-vertex normal attribute to compute
// (a real cost on a 400k-triangle mesh), and the faceted look suits 3D-print models. Matches
// what three's ThreeMFLoader used for its default meshes.
const BAKED_GRAY = new THREE.MeshStandardMaterial({
  color: 0x9a9a9a,
  roughness: 0.6,
  metalness: 0.1,
  flatShading: true,
});

interface BakedPart {
  positions: Float32Array;
  indices: Uint32Array; // empty ⇒ non-indexed
  paint: Uint8Array | null;
}

export function parseBakedMesh(buf: ArrayBuffer): BakedPart[] {
  if (buf.byteLength < 8) return [];
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MESH_MAGIC) return [];
  const partCount = dv.getUint32(4, true);
  const parts: BakedPart[] = [];
  let off = 8;
  for (let i = 0; i < partCount; i++) {
    if (off + 12 > buf.byteLength) break;
    const floatCount = dv.getUint32(off, true);
    const indexCount = dv.getUint32(off + 4, true);
    const flags = dv.getUint32(off + 8, true);
    off += 12;

    const positions = new Float32Array(buf.slice(off, off + floatCount * 4));
    off += floatCount * 4;
    const indices = new Uint32Array(buf.slice(off, off + indexCount * 4));
    off += indexCount * 4;

    let paint: Uint8Array | null = null;
    if (flags & 1) {
      const triCount = indexCount > 0 ? indexCount / 3 : floatCount / 9;
      paint = new Uint8Array(buf.slice(off, off + triCount));
      off += (triCount + 3) & ~3; // 4-byte aligned
    }
    parts.push({ positions, indices, paint });
  }
  return parts;
}

/**
 * Builds a THREE.Group (one Mesh per baked part, in part order) from a "PSM1" blob. The part
 * order matches the 3MF `<build><item>` order, so `visibleChildIndices` plate toggling and
 * `frameObject` / `frameVisibleChildren` work exactly as they did with ThreeMFLoader's output.
 * Each mesh's per-triangle filament slots (painted 3MFs) are stashed on `mesh.userData.paint`
 * for `applyPaintColors`.
 */
export function loadBakedMesh(buf: ArrayBuffer): THREE.Group {
  const group = new THREE.Group();
  for (const part of parseBakedMesh(buf)) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
    if (part.indices.length > 0) geom.setIndex(new THREE.BufferAttribute(part.indices, 1));
    const mesh = new THREE.Mesh(geom, BAKED_GRAY);
    mesh.userData.paint = part.paint;
    group.add(mesh);
  }
  return group;
}

/**
 * Paints each mesh of `object` in its real filament colours from the per-triangle slots the
 * baker stashed on `mesh.userData.paint`. Geometry comes from our own baker so triangle
 * counts are exact — no matching heuristics. Returns true if anything was painted.
 */
export function applyPaintColors(object: THREE.Object3D, filamentColors: string[]): boolean {
  const palette = (filamentColors.length > 0 ? filamentColors : ['#9a9a9a']).map((c) =>
    new THREE.Color().setStyle(c || '#9a9a9a')
  );
  const base = palette[0];
  let painted = false;

  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const paint = mesh.userData?.paint as Uint8Array | null | undefined;
    if (!mesh.isMesh || !paint || mesh.userData.unpainted) return;

    const src = mesh.geometry as THREE.BufferGeometry;
    const geom = src.index ? src.toNonIndexed() : src.clone();
    const triCount = paint.length;
    const colors = new Uint8Array(triCount * 9);
    for (let t = 0; t < triCount; t++) {
      const c = palette[paint[t]] ?? base;
      const r = Math.round(c.r * 255);
      const g = Math.round(c.g * 255);
      const b = Math.round(c.b * 255);
      for (let k = 0; k < 3; k++) {
        const idx = t * 9 + k * 3;
        colors[idx] = r;
        colors[idx + 1] = g;
        colors[idx + 2] = b;
      }
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));

    mesh.userData.unpainted = { geometry: mesh.geometry, material: mesh.material };
    mesh.geometry = geom;
    mesh.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      metalness: 0,
      flatShading: true,
    });
    painted = true;
  });
  return painted;
}

/** Restores the original geometry/material stashed by applyPaintColors. */
export function removePaintColors(object: THREE.Object3D): void {
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const saved = mesh.userData?.unpainted as { geometry: THREE.BufferGeometry; material: THREE.Material } | undefined;
    if (!mesh.isMesh || !saved) return;
    (mesh.geometry as THREE.BufferGeometry).dispose();
    const mat = mesh.material;
    (Array.isArray(mat) ? mat : [mat]).forEach((m) => (m as THREE.Material).dispose());
    mesh.geometry = saved.geometry;
    mesh.material = saved.material;
    delete mesh.userData.unpainted;
  });
}

// Optional in-plane extent (mm) the framing must also keep visible — the print bed, which
// can be larger than the model itself. Only X/Y matter; the bed has no height.
export interface FloorExtent {
  x: number;
  y: number;
}

// Returns the box's size so callers (the print-bed grid) can size/position themselves
// relative to the framed object without recomputing the bounding box a second time.
function frameBox(
  box: THREE.Box3,
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  floor?: FloorExtent
): THREE.Vector3 {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  object.position.sub(center);

  // Fit the larger of the model and the build plate so a small part on a big bed still
  // shows the whole bed.
  const fitX = Math.max(size.x, floor?.x ?? 0);
  const fitY = Math.max(size.y, floor?.y ?? 0);
  const maxDim = Math.max(fitX, fitY, size.z) || 1;
  const fitDistance = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360));
  const distance = fitDistance * 1.6;

  // Models are Z-up (build plate = XY plane). Orient the camera Z-up too and view from a
  // low, mostly head-on angle so the plate reads as horizontal and sits toward the bottom
  // of the frame; the narrow FOV set on the Canvas keeps perspective distortion subtle
  // ("somewhat orthographic").
  camera.up.set(0, 0, 1);
  camera.position.set(distance * 0.32, -distance * 0.92, distance * 0.42);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);

  return size;
}

export function frameObject(
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  floor?: FloorExtent
): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(object);
  return frameBox(box, object, camera, floor);
}

/**
 * Like frameObject, but frames only the currently-visible top-level children (used for the
 * multi-plate 3MF viewer, where a plate switch toggles child.visible per build item rather
 * than reloading the model). THREE.Box3.setFromObject ignores the `.visible` flag entirely,
 * so a plain frameObject(object, camera) call here would keep framing the whole merged model
 * even when only one plate's meshes are shown.
 *
 * Resets object.position to zero before recomputing, so repeated calls (switching between
 * plates on the same loaded Group) don't compound translation offsets from a previous call.
 */
export function frameVisibleChildren(
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  floor?: FloorExtent
): THREE.Vector3 {
  object.position.set(0, 0, 0);
  object.updateMatrixWorld(true);

  const box = new THREE.Box3();
  let any = false;
  for (const child of object.children) {
    if (child.visible === false) continue;
    box.expandByObject(child);
    any = true;
  }

  if (!any) {
    // Nothing visible (e.g. a plate with no mapped build items) — fall back to the whole model.
    return frameObject(object, camera, floor);
  }
  return frameBox(box, object, camera, floor);
}

/**
 * Both frameObject and frameVisibleChildren center the framed box at the origin (via
 * `object.position.sub(center)`), so afterwards the box is always symmetric about (0,0,0)
 * on every axis — its bottom face sits at z = -size.z/2 in world space. STL/OBJ/3MF data
 * for 3D printing is conventionally Z-up (the build plate is the XY plane, Z is height),
 * so that's exactly where a print-bed grid belongs. Exported so ModelViewer can size and
 * position the bed without duplicating this box-centering assumption.
 */
export function bedZ(sizeZ: number): number {
  return -sizeZ / 2;
}
