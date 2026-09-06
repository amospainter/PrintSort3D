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
