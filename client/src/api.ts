export interface DuplicateEntry {
  id: number;
  filename: string;
  relativePath: string;
  rootLabel: string;
  matchType: 'exact' | 'geometry';
}

export interface PlateEntry {
  index: number;
  images: string[]; // absolute URLs, e.g. "/api/assets/12/plate_2.webp"
  // Indices into the 3D viewer's build-item order (Group.children from ThreeMFLoader.parse),
  // i.e. which meshes belong to this plate. Absent for non-Bambu 3MFs / unmapped plates —
  // the viewer falls back to showing the whole model when this is missing.
  buildItemIndices?: number[];
  // Human-assigned plate name (Bambu Studio/OrcaSlicer's plate-tab rename, e.g. "Body").
  // Absent when the plate was never renamed — callers fall back to "Plate N".
  name?: string;
}

export interface PlateSize {
  x: number; // mm
  y: number; // mm
}

export interface TagInfo {
  name: string;
  color: string | null; // explicit hex choice, or null to use the auto palette colour
  count: number;
}

export interface AppSettings {
  defaultPlateSize: PlateSize;
}

export interface ArchiveEntry {
  path: string; // zip entry path, e.g. "Models/widget.stl"
  ext: string;
  sizeBytes: number;
}

export interface FileEntry {
  id: number;
  filename: string;
  ext: string;
  sizeBytes: number;
  mtime: number;
  addedAt: number;
  notes: string;
  thumbnailUrl: string | null;
  missing: boolean;
  root: { label?: string; path?: string };
  relativePath: string;
  filamentType: string | null;
  filamentColor: string | null;
  filaments: { color: string; type: string | null }[]; // every configured filament slot (multi-color / AMS prints)
  meshUrl: string | null; // /api/files/:id/mesh — server-baked render mesh (positions/indices + folded-in paint), else null
  layerHeight: string | null;
  slicerMetadata: Record<string, unknown> | null;
  embeddedImages: string[]; // absolute URLs, e.g. "/api/assets/12/plate_1.webp"
  dimensions: { x: number; y: number; z: number } | null; // computed server-side during scan
  tags: string[];
  contentHash: string | null;
  geometryHash: string | null;
  duplicateCount: number;
  duplicates?: DuplicateEntry[]; // only present on GET /files/:id, not in list responses
  archiveEntryCount: number | null; // non-null only for .zip files
  plates: PlateEntry[]; // multi-plate 3MF grouping; empty for non-3MF or unparsed files
  bedSize: PlateSize; // build-plate footprint for the viewer — declared size (Bambu 3MF) or the app default
  plateSizeSource: 'file' | 'default'; // whether bedSize came from the file or the configured fallback
}

export interface RootConfig {
  label: string;
  path: string;
  managed?: boolean; // env-provided (e.g. Docker mount) — always scanned, not user-removable
}

export interface FolderEntry {
  root: string; // watched-folder label this directory lives under
  path: string; // "/"-joined path relative to that root, e.g. "vehicles/cars"
  name: string; // last path segment
  fileCount: number; // files at or below this directory (recursive)
}

export interface ScanResult {
  added: number;
  updated: number;
  missing: number;
}

export interface FilesPage {
  items: FileEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listFiles(
    params: {
      query?: string;
      root?: string;
      folder?: string;
      tags?: string[];
      ext?: string;
      sort?: string;
      page?: number;
      pageSize?: number;
      duplicatesOnly?: boolean;
    } = {}
  ) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (k === 'tags') {
        if (Array.isArray(v) && v.length > 0) qs.set('tags', v.join(','));
        continue;
      }
      if (v) qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<FilesPage>(`/api/files${suffix}`);
  },
  getFile(id: number) {
    return request<FileEntry>(`/api/files/${id}`);
  },
  updateFile(id: number, patch: { notes?: string; tags?: string[] }) {
    return request<FileEntry>(`/api/files/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
  listTags() {
    return request<TagInfo[]>('/api/tags');
  },
  setTagColor(name: string, color: string | null) {
    return request<TagInfo>(`/api/tags/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ color }),
    });
  },
  deleteTag(name: string) {
    return request<{ ok: true }>(`/api/tags/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },
  getSettings() {
    return request<AppSettings>('/api/settings');
  },
  updateSettings(patch: AppSettings) {
    return request<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  },
  scan(root?: string) {
    return request<ScanResult>('/api/scan', {
      method: 'POST',
      body: root ? JSON.stringify({ root }) : undefined,
    });
  },
  getRoots() {
    return request<RootConfig[]>('/api/roots');
  },
  listFolders() {
    return request<FolderEntry[]>('/api/folders');
  },
  setRoots(roots: RootConfig[]) {
    return request<RootConfig[]>('/api/roots', {
      method: 'PUT',
      body: JSON.stringify(roots),
    });
  },
  uploadThumbnail(id: number, imageBase64: string) {
    return request<{ ok: true }>(`/api/files/${id}/thumbnail`, {
      method: 'POST',
      body: JSON.stringify({ imageBase64 }),
    });
  },
  rawFileUrl(id: number) {
    return `/api/raw/${id}`;
  },
  listArchiveEntries(id: number) {
    return request<ArchiveEntry[]>(`/api/files/${id}/archive`);
  },
  archiveEntryRawUrl(id: number, entryPath: string) {
    return `/api/files/${id}/archive-raw?path=${encodeURIComponent(entryPath)}`;
  },
  rescanFile(id: number) {
    return request<FileEntry & { rescanStatus: 'ok' | 'missing' }>(`/api/files/${id}/rescan`, { method: 'POST' });
  },
};
