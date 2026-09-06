import AdmZip from 'adm-zip';
import path from 'path';

export interface PlateSize {
  x: number; // mm
  y: number; // mm
}

export interface FilamentInfo {
  color: string; // normalized "#RRGGBB" (or "#RRGGBBAA")
  type: string | null; // parallel filament_type entry, if present
}

export interface ThreeMfExtract {
  thumbnailBuffer: Buffer | null;
  filamentType: string | null;
  filamentColor: string | null;
  filaments: FilamentInfo[]; // every configured filament slot (multi-color / AMS prints), color + type
  layerHeight: string | null;
  rawMetadata: Record<string, unknown> | null;
  plateSize: PlateSize | null; // build-plate footprint from Bambu/Orca slicer settings, if declared
}

const BED_CORNER_RE = /^\s*(-?\d+(?:\.\d+)?)\s*x\s*(-?\d+(?:\.\d+)?)\s*$/i;

/**
 * Bambu Studio / OrcaSlicer project_settings.config records the printable bed as a polygon
 * of "XxY" corner strings under `printable_area` (older Slic3r-lineage exports use
 * `bed_shape`). The plate footprint is the bounding box of those corners. Returns null when
 * the key is absent or unparseable — the caller falls back to the app's configured default.
 */
export function parsePlateSize(rawMetadata: Record<string, unknown> | null): PlateSize | null {
  if (!rawMetadata) return null;
  const area = rawMetadata.printable_area ?? rawMetadata.bed_shape;
  if (!Array.isArray(area) || area.length < 2) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const corner of area) {
    const m = BED_CORNER_RE.exec(String(corner));
    if (!m) continue;
    xs.push(Number(m[1]));
    ys.push(Number(m[2]));
  }
  if (xs.length < 2 || ys.length < 2) return null;

  const x = Math.max(...xs) - Math.min(...xs);
  const y = Math.max(...ys) - Math.min(...ys);
  if (!(x > 0) || !(y > 0)) return null;

  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

const THUMBNAIL_CANDIDATES = [
  'Metadata/plate_1.png',
  'Metadata/plate_no_light_1.png',
  'Metadata/top_1.png',
  'Metadata/thumbnail_middle.png',
  'Metadata/thumbnail_small.png',
];

// Bambu Studio / OrcaSlicer project_settings.config is a flat JSON object of
// slicer settings. Values for multi-extruder printers are arrays; we take
// the first entry as the representative value.
function firstValue(v: unknown): string | null {
  if (Array.isArray(v)) return v.length > 0 ? String(v[0]) : null;
  if (v === undefined || v === null) return null;
  return String(v);
}

// A settings value as a list, whether it's stored as an array (multi-extruder) or a
// lone scalar (single-extruder profile). Used to line up filament_colour with the
// parallel filament_type array.
function arrayValues(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v === undefined || v === null) return [];
  return [String(v)];
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/**
 * Every filament slot declared in a Bambu/Orca project_settings.config, as color+type pairs.
 * `filament_colour` (or the American `filament_color`) is one entry per AMS/extruder slot in
 * the printer profile — a 4-color print keeps 4 entries here even though the older single
 * `filamentColor` field only ever saw the first. `filament_type` runs parallel. Entries whose
 * color isn't a "#RRGGBB(AA)" hex string are dropped (nothing meaningful to render as a swatch).
 */
function parseFilaments(json: Record<string, unknown>): FilamentInfo[] {
  const colors = arrayValues(json.filament_colour ?? json.filament_color);
  const types = arrayValues(json.filament_type);
  const filaments: FilamentInfo[] = [];
  for (let i = 0; i < colors.length; i++) {
    const color = colors[i].trim().toUpperCase();
    if (!HEX_COLOR_RE.test(color)) continue;
    filaments.push({ color, type: types[i] ?? null });
  }
  return filaments;
}

export interface ThreeMfImageEntry {
  name: string; // basename only, e.g. "plate_1.png"
  buffer: Buffer;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

// Every image embedded under Metadata/ — plate renders, "no light" variants,
// top-down/pick shots, per-plate previews, etc. Used to build the Detail page's
// embedded-image gallery (a superset of the single thumbnail picked by extractThreeMfData).
export function listThreeMfImages(filePath: string): ThreeMfImageEntry[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return [];
  }

  const results: ThreeMfImageEntry[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.startsWith('Metadata/')) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    try {
      results.push({ name: path.basename(entry.entryName), buffer: entry.getData() });
    } catch {
      // A single malformed zip entry (bad CRC/descriptor, corrupt/truncated 3MF, etc.)
      // shouldn't take down extraction for every other image in the file — skip it.
    }
  }
  return results;
}

export interface PlateInfo {
  index: number;
  images: string[]; // cached asset filenames belonging to this plate, e.g. "plate_2.webp"
  buildItemIndices?: number[]; // indices into the 3D viewer's build-item order (see computePlateBuildIndices)
  name?: string; // human-assigned plate name from Bambu/Orca's plate tab (see computePlateNames), if renamed
}

const PLATE_NUMBER_RE = /^(?:plate_no_light_|plate_|top_)(\d+)$/i;

/**
 * Groups a 3MF's cached embedded-image filenames (from cacheThreeMfImages) by the plate
 * number encoded in Bambu/Orca's naming convention (plate_N.*, plate_no_light_N.*, top_N.*).
 * Files with no numbered plate images (most non-Bambu 3MFs, or single-plate projects using
 * only thumbnail_small/thumbnail_middle) collapse into one implicit plate 1, so callers never
 * need a separate "no plates" case.
 */
export function groupImagesByPlate(imageNames: string[]): PlateInfo[] {
  const byPlate = new Map<number, string[]>();
  const unnumbered: string[] = [];

  for (const name of imageNames) {
    const base = path.basename(name, path.extname(name));
    const match = PLATE_NUMBER_RE.exec(base);
    if (match) {
      const index = Number(match[1]);
      if (!byPlate.has(index)) byPlate.set(index, []);
      byPlate.get(index)!.push(name);
    } else {
      unnumbered.push(name);
    }
  }

  const plates = [...byPlate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, images]) => ({ index, images }));

  if (plates.length === 0 && unnumbered.length > 0) {
    plates.push({ index: 1, images: unnumbered });
  }

  return plates;
}

interface RawPlateObjects {
  platerId: number;
  objectIds: string[];
  name: string | null;
}

const PLATE_BLOCK_RE = /<plate>([\s\S]*?)<\/plate>/g;
const PLATER_ID_RE = /<metadata key="plater_id" value="(\d+)"\s*\/>/;
const PLATER_NAME_RE = /<metadata key="plater_name" value="([^"]*)"\s*\/>/;
const MODEL_INSTANCE_OBJECT_ID_RE = /<model_instance>\s*<metadata key="object_id" value="(\d+)"/g;

// Metadata/model_settings.config's <plate> blocks (Bambu/Orca) list, per plate, the
// <model_instance> object_ids placed on it — these object_ids are the same ones used as
// <item objectid="..."> in 3D/3dmodel.model's <build> section (confirmed against a real
// Bambu export), not a separate id space requiring further indirection through <object>/
// <component> resolution. Each block also carries a plater_name — the label shown on the
// plate's tab in Bambu Studio/OrcaSlicer if the user renamed it (e.g. "Body", "Eyes");
// left blank ("") for plates nobody bothered to rename, which we normalize to null.
function parsePlateObjectIds(modelSettingsXml: string): RawPlateObjects[] {
  const plates: RawPlateObjects[] = [];
  let blockMatch: RegExpExecArray | null;
  PLATE_BLOCK_RE.lastIndex = 0;
  while ((blockMatch = PLATE_BLOCK_RE.exec(modelSettingsXml)) !== null) {
    const block = blockMatch[1];
    const platerIdMatch = PLATER_ID_RE.exec(block);
    if (!platerIdMatch) continue;
    const objectIds: string[] = [];
    let instMatch: RegExpExecArray | null;
    MODEL_INSTANCE_OBJECT_ID_RE.lastIndex = 0;
    while ((instMatch = MODEL_INSTANCE_OBJECT_ID_RE.exec(block)) !== null) {
      objectIds.push(instMatch[1]);
    }
    const nameMatch = PLATER_NAME_RE.exec(block);
    const name = nameMatch && nameMatch[1].trim() ? nameMatch[1].trim() : null;
    plates.push({ platerId: Number(platerIdMatch[1]), objectIds, name });
  }
  return plates;
}

const BUILD_ITEM_OBJECTID_RE = /<item\b[^>]*\bobjectid="(\d+)"/g;

function parseBuildItemOrder(modelXml: string): string[] {
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  BUILD_ITEM_OBJECTID_RE.lastIndex = 0;
  while ((m = BUILD_ITEM_OBJECTID_RE.exec(modelXml)) !== null) ids.push(m[1]);
  return ids;
}

/**
 * Maps each Bambu/Orca plate (by its plater_id, the same number used in
 * Metadata/plate_N.* filenames that groupImagesByPlate parses) to the indices of the
 * <item> elements in the root 3D/3dmodel.model's <build> section that belong to it.
 * Three.js's ThreeMFLoader.parse() builds exactly one Group child per build item, in the
 * same document order (see 3MFLoader.js's `build()`), so these indices double as indices
 * into that Group's `.children` client-side — letting the 3D viewer show/hide individual
 * plates instead of always rendering every plate merged together. Returns an empty map
 * for non-Bambu 3MFs (no Metadata/model_settings.config) or on any parse failure — the
 * client falls back to showing the whole model when a plate has no mapped indices.
 */
export function computePlateBuildIndices(filePath: string): Map<number, number[]> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return new Map();
  }

  const settingsEntry = zip.getEntry('Metadata/model_settings.config');
  const modelEntry = zip.getEntry('3D/3dmodel.model');
  if (!settingsEntry || !modelEntry) return new Map();

  let settingsXml: string;
  let modelXml: string;
  try {
    settingsXml = settingsEntry.getData().toString('utf-8');
    modelXml = modelEntry.getData().toString('utf-8');
  } catch {
    return new Map();
  }

  const plates = parsePlateObjectIds(settingsXml);
  if (plates.length === 0) return new Map();
  const buildOrder = parseBuildItemOrder(modelXml);

  const result = new Map<number, number[]>();
  for (const plate of plates) {
    const indices = plate.objectIds.map((id) => buildOrder.indexOf(id)).filter((i) => i !== -1);
    if (indices.length > 0) result.set(plate.platerId, indices);
  }
  return result;
}

/**
 * Maps each Bambu/Orca plate's plater_id to its human-assigned name (Bambu Studio/
 * OrcaSlicer's "rename this plate" — e.g. "Body", "Eyes"). Plates nobody renamed have no
 * entry (parsePlateObjectIds already normalizes an empty plater_name to null), so callers
 * fall back to "Plate N" for those. Kept separate from computePlateBuildIndices — same
 * underlying model_settings.config parse, different return shape — rather than folding
 * name into that function's Map<number, number[]> and breaking its existing callers.
 */
export function computePlateNames(filePath: string): Map<number, string> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return new Map();
  }

  const settingsEntry = zip.getEntry('Metadata/model_settings.config');
  if (!settingsEntry) return new Map();

  let settingsXml: string;
  try {
    settingsXml = settingsEntry.getData().toString('utf-8');
  } catch {
    return new Map();
  }

  const result = new Map<number, string>();
  for (const plate of parsePlateObjectIds(settingsXml)) {
    if (plate.name) result.set(plate.platerId, plate.name);
  }
  return result;
}

export function extractThreeMfData(filePath: string): ThreeMfExtract {
  const result: ThreeMfExtract = {
    thumbnailBuffer: null,
    filamentType: null,
    filamentColor: null,
    filaments: [],
    layerHeight: null,
    rawMetadata: null,
    plateSize: null,
  };

  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return result;
  }

  for (const candidate of THUMBNAIL_CANDIDATES) {
    const entry = zip.getEntry(candidate);
    if (!entry) continue;
    try {
      result.thumbnailBuffer = entry.getData();
      break;
    } catch {
      // This candidate's entry is malformed (bad CRC/descriptor) — try the next one.
    }
  }

  const settingsEntry = zip.getEntry('Metadata/project_settings.config');
  if (settingsEntry) {
    try {
      const json = JSON.parse(settingsEntry.getData().toString('utf-8'));
      result.rawMetadata = json;
      result.filamentType = firstValue(json.filament_type);
      result.filamentColor = firstValue(json.filament_colour ?? json.filament_color);
      result.filaments = parseFilaments(json);
      result.layerHeight = firstValue(json.layer_height);
      result.plateSize = parsePlateSize(json);
    } catch {
      // not valid JSON / not a Bambu-format project settings file — ignore
    }
  }

  return result;
}
