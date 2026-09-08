import AdmZip from 'adm-zip';

/**
 * Autodesk Fusion 360 `.f3d` archives. These are ZIP containers holding the parametric
 * design in Autodesk's proprietary B-rep format (`Breps.BlobParts/*.smb`) — there's no mesh
 * to extract or render. What they DO carry is a rendered preview thumbnail at
 * `<AssetName>/Previews/small.png`, which is all the scanner takes from them. Everything else
 * (dimensions, geometry hash, baked mesh) is skipped for `.f3d`; it's a catalogued CAD source
 * you open in Fusion.
 */

const PREVIEW_RE = /(^|\/)Previews\/[^/]+\.png$/i;

/** Extracts the embedded Fusion preview image. Returns null when absent or unreadable. */
export function extractF3dThumbnail(filePath: string): Buffer | null {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return null;
  }

  // Prefer the largest PNG under a `Previews/` folder (Fusion writes `small.png`; newer
  // versions may add more sizes). `Images.BlobParts/*` are appearance textures, not previews.
  let best: { entry: AdmZip.IZipEntry; size: number } | null = null;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !PREVIEW_RE.test(entry.entryName)) continue;
    const size = entry.header.size;
    if (!best || size > best.size) best = { entry, size };
  }
  if (!best) return null;

  try {
    return best.entry.getData();
  } catch {
    return null;
  }
}
