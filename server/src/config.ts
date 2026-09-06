import fs from 'fs';
import path from 'path';

export interface RootConfig {
  label: string;
  path: string;
  // Present and `true` for roots injected from the environment (PRINTSORT_ROOTS /
  // PRINTSORT_MODELS_DIR) rather than added through the Settings UI. These aren't written
  // to config.json and can't be removed via the API — they're owned by the deployment
  // (e.g. Docker volume mounts). User-added roots have no `managed` key at all.
  managed?: boolean;
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

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// Roots supplied by the environment, re-read on every loadConfig() so newly-mounted folders
// show up without a restart. Two independent sources, both optional:
//   PRINTSORT_ROOTS       ";"- or newline-separated entries, each "Label=/path" or "/path"
//   PRINTSORT_MODELS_DIR  a parent dir; every immediate subdirectory becomes a root
//                         (label = the subdirectory's name)
function parseEnvRoots(): RootConfig[] {
  const out: RootConfig[] = [];
  const seen = new Set<string>();

  const add = (rawPath: string, rawLabel?: string) => {
    const p = rawPath.trim();
    if (!p) return;
    const resolved = path.resolve(p);
    const key = resolved.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const label = rawLabel?.trim() || path.basename(resolved) || resolved;
    out.push({ label, path: resolved, managed: true });
  };

  const list = process.env.PRINTSORT_ROOTS;
  if (list) {
    for (const entry of list.split(/[;\n]/)) {
      if (!entry.trim()) continue;
      const eq = entry.indexOf('=');
      if (eq > 0) add(entry.slice(eq + 1), entry.slice(0, eq));
      else add(entry);
    }
  }

  const parent = process.env.PRINTSORT_MODELS_DIR;
  if (parent) {
    try {
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) add(path.join(parent, entry.name), entry.name);
      }
    } catch {
      // parent dir missing / unreadable — nothing to add
    }
  }

  return out;
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  let fileRoots: RootConfig[] = [];
  let defaultPlateSize = { ...DEFAULT_PLATE_SIZE };

  if (!fs.existsSync(configPath)) {
    const initial: AppConfig = { roots: [], defaultPlateSize: { ...DEFAULT_PLATE_SIZE } };
    fs.writeFileSync(configPath, JSON.stringify(initial, null, 2));
  } else {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<AppConfig>;
    fileRoots = Array.isArray(parsed.roots)
      ? parsed.roots.map((r) => ({ label: r.label, path: r.path }))
      : [];
    defaultPlateSize = normalizePlateSize(parsed.defaultPlateSize);
  }

  const envRoots = parseEnvRoots();
  // An env root wins over a same-path file root (it becomes managed).
  const userRoots = fileRoots.filter((r) => !envRoots.some((e) => samePath(e.path, r.path)));

  return { roots: [...userRoots, ...envRoots], defaultPlateSize };
}

export function saveConfig(config: { roots: RootConfig[]; defaultPlateSize?: PlateSize }): void {
  // Managed (env-derived) roots are never persisted — they're re-derived on every load.
  const persisted: AppConfig = {
    roots: config.roots.filter((r) => !r.managed).map((r) => ({ label: r.label, path: r.path })),
    defaultPlateSize: normalizePlateSize(config.defaultPlateSize),
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(persisted, null, 2));
}
