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
