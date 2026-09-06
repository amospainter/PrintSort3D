import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { ASSETS_DIR } from './paths';
import { listThreeMfImages } from './threeMf';

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

export function deleteCachedImages(fileId: number): void {
  const dir = path.join(ASSETS_DIR, String(fileId));
  fs.rmSync(dir, { recursive: true, force: true });
}
