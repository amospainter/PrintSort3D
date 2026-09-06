import fs from 'fs';
import path from 'path';

export interface RootConfig {
  label: string;
  path: string;
}

export interface PlateSize {
  x: number; // mm
  y: number; // mm
}

export interface AppConfig {
  roots: RootConfig[];
  // Build-plate footprint used by the 3D viewer for files that don't declare their own
  // (non-Bambu 3MFs, STL/OBJ, unparseable slicer settings). User-editable in Settings.
  defaultPlateSize: PlateSize;
}

export const DEFAULT_PLATE_SIZE: PlateSize = { x: 256, y: 256 };

function getConfigPath(): string {
  return process.env.CONFIG_PATH ?? path.join(__dirname, '..', 'config.json');
}

function normalizePlateSize(value: unknown): PlateSize {
  const v = value as { x?: unknown; y?: unknown } | null | undefined;
  const x = Number(v?.x);
  const y = Number(v?.y);
  if (x > 0 && y > 0) return { x, y };
  return { ...DEFAULT_PLATE_SIZE };
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    const initial: AppConfig = { roots: [], defaultPlateSize: { ...DEFAULT_PLATE_SIZE } };
    fs.writeFileSync(configPath, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<AppConfig>;
  return {
    roots: Array.isArray(parsed.roots) ? parsed.roots : [],
    defaultPlateSize: normalizePlateSize(parsed.defaultPlateSize),
  };
}

export function saveConfig(config: { roots: RootConfig[]; defaultPlateSize?: PlateSize }): void {
  const normalized: AppConfig = {
    roots: config.roots,
    defaultPlateSize: normalizePlateSize(config.defaultPlateSize),
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(normalized, null, 2));
}
