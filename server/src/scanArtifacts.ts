import fs from 'fs';
import { extractThreeMfData, groupImagesByPlate, computePlateInfo, type PlateInfo } from './threeMf';
import { extractSliceInfo, type SliceInfo } from './sliceInfo';
import { cacheThreeMfImages, cacheBakedMeshParts, saveThumbnail } from './assets';
import { computeDimensions, dimensionsFromParts, type Dimensions } from './dimensions';
import { computeContentHash, computeGeometryHash, computeGeometryHashFromParts } from './fingerprint';
import { listArchiveModelEntries } from './archive';
import { extractF3dThumbnail } from './f3d';
import { bakeModel, type BakedPart } from './meshBake';
import { renderBakedThumbnail } from './thumbnail';

/**
 * The per-file "extract" half of a scan: everything that can be computed from a file on disk
 * — parsing, hashing, rendering, and writing the derived artifacts under ASSETS_DIR — with
 * **no database access**. `scanner.ts` takes the returned struct and does the (main-thread,
 * single-writer) DB updates. Keeping this DB-free is what lets it run inside a worker thread
 * (`scanWorker.ts`) so a big scan parallelises across cores instead of blocking one.
 */

export interface ThreeMfArtifacts {
  filamentType: string | null;
  filamentColor: string | null;
  filamentsJson: string | null;
  layerHeight: string | null;
  slicerMetadataJson: string | null;
  embeddedImagesJson: string | null;
  platesJson: string | null;
  plateSizeJson: string | null;
  sliceInfoJson: string | null;
}

export interface FileArtifacts {
  dimensions: Dimensions | null;
  meshCached: boolean; // mesh.bin.gz written under ASSETS_DIR/<id>/
  contentHash: string | null;
  geometryHash: string | null;
  thumbnailWritten: boolean; // thumbnail.png written (embedded plate image or CPU render)
  threeMf: ThreeMfArtifacts | null;
  archiveEntryCount: number | null;
}

function bakeParts(fullPath: string, ext: string): BakedPart[] | null {
  let parts: BakedPart[] | null;
  try {
    parts = bakeModel(fullPath, ext);
  } catch {
    return null; // one unparseable model must not abort the scan
  }
  return parts && parts.length > 0 ? parts : null;
}

function buildThreeMfArtifacts(
  fileId: number,
  fullPath: string,
  embeddedImages: string[]
): { artifacts: ThreeMfArtifacts; hasEmbeddedThumbnail: boolean } {
  const extracted = extractThreeMfData(fullPath);
  let hasEmbeddedThumbnail = false;
  if (extracted.thumbnailBuffer) {
    saveThumbnail(fileId, extracted.thumbnailBuffer);
    hasEmbeddedThumbnail = true;
  }

  const plates: PlateInfo[] = groupImagesByPlate(embeddedImages);
  const { buildIndices, names } = computePlateInfo(fullPath);
  for (const plate of plates) {
    const idx = buildIndices.get(plate.index);
    if (idx) plate.buildItemIndices = idx;
    const nm = names.get(plate.index);
    if (nm) plate.name = nm;
  }
  const sliceInfo: SliceInfo | null = extractSliceInfo(fullPath);

  return {
    hasEmbeddedThumbnail,
    artifacts: {
      filamentType: extracted.filamentType,
      filamentColor: extracted.filamentColor,
      filamentsJson: extracted.filaments.length > 0 ? JSON.stringify(extracted.filaments) : null,
      layerHeight: extracted.layerHeight,
      slicerMetadataJson: extracted.rawMetadata ? JSON.stringify(extracted.rawMetadata) : null,
      embeddedImagesJson: embeddedImages.length > 0 ? JSON.stringify(embeddedImages) : null,
      platesJson: plates.length > 0 ? JSON.stringify(plates) : null,
      plateSizeJson: extracted.plateSize ? JSON.stringify(extracted.plateSize) : null,
      sliceInfoJson: sliceInfo ? JSON.stringify(sliceInfo) : null,
    },
  };
}

export async function extractArtifacts(
  fileId: number,
  fullPath: string,
  ext: string
): Promise<FileArtifacts> {
  const isMesh = ext === '.stl' || ext === '.obj' || ext === '.3mf';
  const parts = isMesh ? bakeParts(fullPath, ext) : null;

  let meshCached = false;
  if (parts) {
    cacheBakedMeshParts(fileId, parts);
    meshCached = true;
  }
  const dimensions = parts ? dimensionsFromParts(parts) : computeDimensions(fullPath, ext);

  let threeMf: ThreeMfArtifacts | null = null;
  let hasEmbeddedThumbnail = false;
  if (ext === '.3mf') {
    const embeddedImages = await cacheThreeMfImages(fileId, fullPath);
    const built = buildThreeMfArtifacts(fileId, fullPath, embeddedImages);
    threeMf = built.artifacts;
    hasEmbeddedThumbnail = built.hasEmbeddedThumbnail;
  }

  const archiveEntryCount =
    ext === '.zip' ? listArchiveModelEntries(fullPath).length : null;

  let thumbnailWritten = hasEmbeddedThumbnail;
  // A Fusion 360 .f3d has no parseable geometry — take its embedded Previews/*.png as the
  // thumbnail and nothing else.
  if (ext === '.f3d') {
    const preview = extractF3dThumbnail(fullPath);
    if (preview) {
      saveThumbnail(fileId, preview);
      thumbnailWritten = true;
    }
  }
  if (parts && !hasEmbeddedThumbnail) {
    const png = await renderBakedThumbnail(parts);
    if (png) {
      saveThumbnail(fileId, png);
      thumbnailWritten = true;
    }
  }

  const contentHash = await computeContentHash(fullPath);
  const geometryHash = parts
    ? computeGeometryHashFromParts(parts)
    : computeGeometryHash(fullPath, ext);

  return { dimensions, meshCached, contentHash, geometryHash, thumbnailWritten, threeMf, archiveEntryCount };
}

/** Cheap existence + stat, so callers don't import fs just for this. */
export function statFile(fullPath: string): { size: number; mtimeMs: number } | null {
  try {
    const st = fs.statSync(fullPath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
