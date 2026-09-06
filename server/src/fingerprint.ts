import fs from 'fs';
import crypto from 'crypto';
import { forEachVertex } from './geometryParse';

/**
 * SHA-256 of the raw file bytes. Catches byte-identical files regardless of filename,
 * location, or extension (e.g. the same STL copied and renamed into two folders).
 */
export function computeContentHash(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    // A file that vanishes/becomes unreadable mid-scan shouldn't abort the whole scan —
    // matches the null-on-failure contract of computeDimensions.
    stream.on('error', () => resolve(null));
  });
}

function round(n: number): number {
  // Snaps to 0.01mm to absorb float rounding noise between different slicers/exporters
  // re-serializing the "same" geometry (e.g. 12.340000001 vs 12.34).
  return Math.round(n * 100) / 100;
}

/**
 * A geometry fingerprint that's invariant to vertex/triangle order (different exporters
 * emit the same mesh in different orders) and translation (normalized to the bounding
 * box's min corner), so the same model re-exported to a different file format hashes
 * identically. Deliberately NOT invariant to rotation or scale — that's a known v1
 * limitation, not a bug. Returns null if the file has no parseable vertex data.
 *
 * Walks the file twice (count+bounding-box, then fill) into flat Float64Arrays rather
 * than building a JS array of [x,y,z] tuples plus a second array of formatted strings —
 * for a real multi-million-triangle STL (normal for print-farm assemblies), the
 * tuple-array + string-array approach held tens of millions of small object/string
 * allocations simultaneously and was observed crashing a real scan with "JavaScript heap
 * out of memory". The sort operates on numeric indices over typed-array storage, and the
 * hash is streamed per sorted vertex instead of joining one giant string.
 */
export function computeGeometryHash(filePath: string, ext: string): string | null {
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  const foundPass1 = forEachVertex(filePath, ext, (x, y, z) => {
    count++;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
  });
  if (!foundPass1 || count === 0) return null;

  const coords = new Float64Array(count * 3);
  let i = 0;
  forEachVertex(filePath, ext, (x, y, z) => {
    coords[i * 3] = round(x - minX);
    coords[i * 3 + 1] = round(y - minY);
    coords[i * 3 + 2] = round(z - minZ);
    i++;
  });

  const order = new Uint32Array(count);
  for (let n = 0; n < count; n++) order[n] = n;
  order.sort((a, b) => {
    const ax = coords[a * 3], ay = coords[a * 3 + 1], az = coords[a * 3 + 2];
    const bx = coords[b * 3], by = coords[b * 3 + 1], bz = coords[b * 3 + 2];
    return ax - bx || ay - by || az - bz;
  });

  const hash = crypto.createHash('sha256');
  hash.update(String(count));
  hash.update('\n');
  for (let n = 0; n < count; n++) {
    const idx = order[n];
    if (n > 0) hash.update(';');
    hash.update(`${coords[idx * 3]},${coords[idx * 3 + 1]},${coords[idx * 3 + 2]}`);
  }
  return hash.digest('hex');
}
