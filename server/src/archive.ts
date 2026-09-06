import AdmZip from 'adm-zip';
import path from 'path';

export interface ArchiveEntryInfo {
  path: string;
  ext: string;
  sizeBytes: number;
}

const MODEL_EXTS = new Set(['.stl', '.3mf', '.obj']);

/**
 * Lists the 3D model files inside a .zip without extracting it to disk. Best-effort,
 * mirroring threeMf.ts's defensiveness: a malformed/corrupt zip returns an empty list
 * rather than throwing.
 */
export function listArchiveModelEntries(filePath: string): ArchiveEntryInfo[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return [];
  }

  const results: ArchiveEntryInfo[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (!MODEL_EXTS.has(ext)) continue;
    results.push({ path: entry.entryName, ext, sizeBytes: entry.header.size });
  }
  return results;
}

/** Reads one entry's raw bytes out of a .zip. Returns null if missing or unreadable. */
export function readArchiveEntry(filePath: string, entryPath: string): Buffer | null {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return null;
  }

  const entry = zip.getEntry(entryPath);
  if (!entry) return null;
  try {
    return entry.getData();
  } catch {
    return null;
  }
}
