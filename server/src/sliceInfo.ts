import AdmZip from 'adm-zip';

/**
 * Parses `Metadata/slice_info.config` — the per-plate slicing result Bambu Studio and
 * OrcaSlicer write into every 3MF they slice (PrusaSlicer does not). It carries the
 * estimates people actually plan around: print time, filament weight and length, the
 * printer model it was sliced for, and whether supports were used.
 *
 * Shape (real Bambu export):
 *
 *   <config>
 *     <plate>
 *       <metadata key="index" value="1"/>
 *       <metadata key="prediction" value="4192"/>        <!-- print time, seconds -->
 *       <metadata key="weight" value="15.99"/>            <!-- filament, grams -->
 *       <metadata key="printer_model_id" value="C11"/>
 *       <metadata key="nozzle_diameters" value="0.4"/>
 *       <metadata key="support_used" value="false"/>
 *       <filament id="1" type="PLA" color="#000000" used_m="5.29" used_g="15.99"/>
 *     </plate>
 *   </config>
 *
 * Multi-plate projects repeat <plate>. We aggregate to file totals and keep the per-plate
 * and per-filament breakdown.
 */

export interface SliceFilamentUsage {
  id: number | null;
  type: string | null;
  color: string | null; // "#RRGGBB" as written by the slicer
  usedGrams: number | null;
  usedMeters: number | null;
}

export interface SlicePlateInfo {
  index: number | null;
  printTimeSeconds: number | null;
  filamentWeightGrams: number | null;
  supportUsed: boolean | null;
  filaments: SliceFilamentUsage[];
}

export interface SliceInfo {
  // File totals (summed across every plate).
  printTimeSeconds: number | null;
  filamentWeightGrams: number | null;
  filamentLengthMeters: number | null;
  printerModelId: string | null; // Bambu model code, e.g. "C11"; null for Orca generic
  nozzleDiameterMm: number | null;
  supportUsed: boolean | null; // true if any plate used supports
  plates: SlicePlateInfo[];
}

const PLATE_BLOCK_RE = /<plate>([\s\S]*?)<\/plate>/g;
const METADATA_RE = /<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g;
const FILAMENT_RE = /<filament\b([^>]*)\/>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function num(v: string | undefined | null): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: string | undefined): boolean | null {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

/** Parses a slice_info.config XML string. Exposed for direct unit testing. */
export function parseSliceInfoXml(xml: string): SliceInfo | null {
  const plates: SlicePlateInfo[] = [];
  let printerModelId: string | null = null;
  let nozzleDiameterMm: number | null = null;

  PLATE_BLOCK_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = PLATE_BLOCK_RE.exec(xml)) !== null) {
    const body = block[1];
    const meta = new Map<string, string>();
    METADATA_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = METADATA_RE.exec(body)) !== null) meta.set(m[1], m[2]);

    printerModelId = printerModelId ?? (meta.get('printer_model_id') || null);
    nozzleDiameterMm = nozzleDiameterMm ?? num((meta.get('nozzle_diameters') ?? '').split(/[,\s]+/)[0]);

    const filaments: SliceFilamentUsage[] = [];
    FILAMENT_RE.lastIndex = 0;
    let f: RegExpExecArray | null;
    while ((f = FILAMENT_RE.exec(body)) !== null) {
      const attrs = new Map<string, string>();
      ATTR_RE.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = ATTR_RE.exec(f[1])) !== null) attrs.set(a[1], a[2]);
      filaments.push({
        id: num(attrs.get('id')),
        type: attrs.get('type') || null,
        color: attrs.get('color') || null,
        usedGrams: num(attrs.get('used_g')),
        usedMeters: num(attrs.get('used_m')),
      });
    }

    plates.push({
      index: num(meta.get('index')),
      printTimeSeconds: num(meta.get('prediction')),
      filamentWeightGrams: num(meta.get('weight')),
      supportUsed: bool(meta.get('support_used')),
      filaments,
    });
  }

  if (plates.length === 0) return null;

  const sum = (pick: (p: SlicePlateInfo) => number | null): number | null => {
    const vals = plates.map(pick).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
  };

  const filamentLengthMeters = (() => {
    const vals = plates
      .flatMap((p) => p.filaments.map((fl) => fl.usedMeters))
      .filter((v): v is number => v != null);
    return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  })();

  const weight = sum((p) => p.filamentWeightGrams);

  return {
    printTimeSeconds: sum((p) => p.printTimeSeconds),
    filamentWeightGrams: weight != null ? Math.round(weight * 100) / 100 : null,
    filamentLengthMeters,
    printerModelId,
    nozzleDiameterMm,
    supportUsed: plates.some((p) => p.supportUsed) ? true : plates.every((p) => p.supportUsed === false) ? false : null,
    plates,
  };
}

/** Reads and parses slice_info.config out of a 3MF. Returns null when absent/unparseable. */
export function extractSliceInfo(filePath: string): SliceInfo | null {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return null;
  }
  const entry = zip.getEntry('Metadata/slice_info.config');
  if (!entry) return null;
  try {
    return parseSliceInfoXml(entry.getData().toString('utf-8'));
  } catch {
    return null;
  }
}
