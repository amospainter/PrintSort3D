import { forEachVertex } from './geometryParse';

export interface Dimensions {
  x: number;
  y: number;
  z: number;
}

class BoundingBoxAccumulator {
  private minX = Infinity;
  private minY = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private maxZ = -Infinity;
  private count = 0;

  add(x: number, y: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    this.count++;
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
  }

  toDimensions(): Dimensions | null {
    if (this.count === 0) return null;
    return { x: this.maxX - this.minX, y: this.maxY - this.minY, z: this.maxZ - this.minZ };
  }
}

/**
 * Computes the model's bounding-box dimensions (in the file's native units — millimeters,
 * by 3D-printing convention) without any rendering: STL/OBJ are parsed directly from bytes,
 * and 3MF's vertex data is read straight out of its zipped XML. Combines all vertices across
 * every object/build-item in a 3MF, matching what a full-plate viewer would show.
 * Returns null if the file can't be parsed or has no vertex data.
 */
export function computeDimensions(filePath: string, ext: string): Dimensions | null {
  const box = new BoundingBoxAccumulator();
  const found = forEachVertex(filePath, ext, (x, y, z) => box.add(x, y, z));
  if (!found) return null;
  return box.toDimensions();
}

/**
 * Dimensions straight from already-baked mesh parts (positions are a flat Float32Array of
 * world-space x/y/z triples). Used by the scanner so a file isn't re-parsed just to get its
 * bounding box — `meshBake.ts` already walked every vertex. For a 3MF this is the *built*
 * geometry with transforms applied (vs. computeDimensions' raw local-vertex union), which
 * also fixes the inflated-box caveat for multi-component assemblies.
 */
export function dimensionsFromParts(
  parts: { positions: Float32Array }[]
): Dimensions | null {
  const box = new BoundingBoxAccumulator();
  for (const part of parts) {
    const p = part.positions;
    for (let i = 0; i + 2 < p.length; i += 3) box.add(p[i], p[i + 1], p[i + 2]);
  }
  return box.toDimensions();
}
