import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import sharp from 'sharp';
import { ASSETS_DIR } from './paths';
import { listThreeMfImages } from './threeMf';
import { bakeModel, BakedPart } from './meshBake';

// Zip entry basenames are a known, slicer-controlled set (plate_1.png, top_2.png, ...),
// but sanitize anyway before it becomes part of a filesystem path.
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Extracts every embedded image from a 3MF file, converts each to WebP, and caches
 * them under ASSETS_DIR/<fileId>/. Returns the cached WebP filenames (not full paths).
 * Best-effort: a single image failing to convert is skipped rather than failing the scan.
 */
export async function cacheThreeMfImages(fileId: number, filePath: string): Promise<string[]> {
  const images = listThreeMfImages(filePath);
  if (images.length === 0) return [];

  const outDir = path.join(ASSETS_DIR, String(fileId));
  fs.mkdirSync(outDir, { recursive: true });

  const savedNames: string[] = [];
  for (const image of images) {
    const baseName = sanitizeName(path.basename(image.name, path.extname(image.name)));
    const outName = `${baseName}.webp`;
    try {
      const webpBuffer = await sharp(image.buffer).webp({ quality: 82 }).toBuffer();
      fs.writeFileSync(path.join(outDir, outName), webpBuffer);
      savedNames.push(outName);
    } catch {
      // Not a valid/decodable image, or a conversion failure — skip it, keep the rest.
    }
  }
  return savedNames;
}

export const BAKED_MESH_FILENAME = 'mesh.bin.gz';
const MESH_MAGIC = 0x314d5350; // "PSM1" little-endian

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** Serializes baked parts into the "PSM1" blob (see meshBake.ts / the format below). */
export function serializeBakedMesh(parts: BakedPart[]): Buffer {
  let size = 8;
  for (const p of parts) {
    const triCount = p.indices.length > 0 ? p.indices.length / 3 : p.positions.length / 9;
    size += 12 + p.positions.length * 4 + p.indices.length * 4 + (p.paint ? align4(triCount) : 0);
  }

  const buf = Buffer.alloc(size);
  let off = 0;
  off = buf.writeUInt32LE(MESH_MAGIC, off);
  off = buf.writeUInt32LE(parts.length, off);
  for (const p of parts) {
    const triCount = p.indices.length > 0 ? p.indices.length / 3 : p.positions.length / 9;
    off = buf.writeUInt32LE(p.positions.length, off);
    off = buf.writeUInt32LE(p.indices.length, off);
    off = buf.writeUInt32LE(p.paint ? 1 : 0, off);
    for (let i = 0; i < p.positions.length; i++) off = buf.writeFloatLE(p.positions[i], off);
    for (let i = 0; i < p.indices.length; i++) off = buf.writeUInt32LE(p.indices[i], off);
    if (p.paint) {
      Buffer.from(p.paint.buffer, p.paint.byteOffset, p.paint.length).copy(buf, off);
      off = align4(off + triCount);
    }
  }
  return buf;
}

/**
 * Bakes an STL/OBJ/3MF into a ready-to-render binary mesh and caches it gzipped at
 * ASSETS_DIR/<fileId>/mesh.bin.gz. Returns the filename, or null when the file couldn't be
 * baked (unsupported, corrupt, or no geometry) — the viewer then falls back to fetching and
 * parsing the raw file. Blob layout (pre-gzip):
 *
 *   uint32LE  magic "PSM1"
 *   uint32LE  partCount            (one part per 3MF <build><item>; STL/OBJ = 1)
 *   per part: uint32LE floatCount  (positions length)
 *             uint32LE indexCount  (0 ⇒ non-indexed triangle soup)
 *             uint32LE flags       (bit0 = hasPaint)
 *             Float32LE * floatCount   world-space vertex positions
 *             Uint32LE  * indexCount
 *             Uint8     * triangleCount    iff hasPaint; 0-based filament slot per triangle
 *             (padded to a 4-byte boundary)
 */
export function cacheBakedMesh(fileId: number, filePath: string, ext: string): string | null {
  let parts: BakedPart[] | null;
  try {
    parts = bakeModel(filePath, ext);
  } catch {
    return null; // a single unparseable model must not abort the whole scan
  }
  if (!parts || parts.length === 0) return null;

  const gz = zlib.gzipSync(serializeBakedMesh(parts));
  const outDir = path.join(ASSETS_DIR, String(fileId));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, BAKED_MESH_FILENAME), gz);
  return BAKED_MESH_FILENAME;
}

export function deleteCachedImages(fileId: number): void {
  const dir = path.join(ASSETS_DIR, String(fileId));
  fs.rmSync(dir, { recursive: true, force: true });
}
