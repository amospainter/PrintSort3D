import AdmZip from 'adm-zip';
import { forEachTriangle } from './geometryParse';
import { decodePaintColor, paintStateToFilamentIndex } from './paintColor';

/**
 * Server-side geometry "bake": parse an STL/OBJ/3MF once at scan time into plain vertex
 * positions + triangle indices (+ per-triangle filament slots for painted 3MFs), so the
 * browser viewer can build a BufferGeometry directly instead of unzipping and DOM-parsing a
 * multi-megabyte model file on the main thread. See assets.ts `cacheBakedMesh` for the
 * on-disk "PSM1" blob format and CLAUDE.md for the pipeline overview.
 */
export interface BakedPart {
  positions: Float32Array; // world-space (3MF build-graph transforms already applied)
  indices: Uint32Array; // empty ⇒ non-indexed triangle soup (STL/OBJ)
  paint: Uint8Array | null; // one 0-based filament slot per triangle, painted 3MFs only
}

// 3×4 affine matrix, row-major: [m00 m01 m02 m03  m10 m11 m12 m13  m20 m21 m22 m23].
type Affine = number[];
const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function multiply(a: Affine, b: Affine): Affine {
  const r = new Array(12).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      let s = col === 3 ? a[row * 4 + 3] : 0;
      for (let k = 0; k < 3; k++) s += a[row * 4 + k] * b[k * 4 + col];
      r[row * 4 + col] = s;
    }
  }
  return r;
}

function determinant3(m: Affine): number {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8])
  );
}

// A 3MF `transform` attribute is 12 floats in column-major order: three basis columns then
// the translation column (matches `parseTransform` in three's 3MFLoader.js).
function parseTransform(s: string | undefined): Affine {
  if (!s) return IDENTITY;
  const t = s.trim().split(/\s+/).map(Number);
  if (t.length < 12 || t.some((n) => !Number.isFinite(n))) return IDENTITY;
  return [t[0], t[3], t[6], t[9], t[1], t[4], t[7], t[10], t[2], t[5], t[8], t[11]];
}

const OBJECT_BLOCK_RE = /<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g;
const MESH_RE = /<mesh>([\s\S]*?)<\/mesh>/;
const COMPONENT_RE = /<component\b[^>]*\/>/g;
const VERTEX_RE = /<vertex\b([^>]*)\/>/g;
const VX_RE = /\bx="(-?[\d.eE+]+)"/;
const VY_RE = /\by="(-?[\d.eE+]+)"/;
const VZ_RE = /\bz="(-?[\d.eE+]+)"/;
const TRIANGLE_RE = /<triangle\b([^>]*)\/>/g;
const T1_RE = /\bv1="(\d+)"/;
const T2_RE = /\bv2="(\d+)"/;
const T3_RE = /\bv3="(\d+)"/;
const PAINT_ATTR_RE = /(?:paint_color|slic3rpe:mmu_segmentation)="([^"]*)"/;
const ITEM_RE = /<item\b[^>]*\/>/g;

interface ModelObject {
  meshXml: string | null;
  components: { objectId: number; path: string | null; transform: Affine }[];
}

// Zip entry names have no leading slash; 3MF component `p:path` values do. Normalize to the
// leading-slash form used as the model map's key.
function normalizePath(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

function parseModelEntries(zip: AdmZip): Map<string, { xml: string; objects: Map<number, ModelObject> }> {
  const models = new Map<string, { xml: string; objects: Map<number, ModelObject> }>();

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !/\.model$/i.test(entry.entryName)) continue;
    let xml: string;
    try {
      xml = entry.getData().toString('utf-8');
    } catch {
      continue; // malformed part file — skip, still try the rest
    }

    const objects = new Map<number, ModelObject>();
    OBJECT_BLOCK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OBJECT_BLOCK_RE.exec(xml)) !== null) {
      const id = Number(m[1]);
      const body = m[2];
      const meshMatch = MESH_RE.exec(body);
      const components: ModelObject['components'] = [];
      COMPONENT_RE.lastIndex = 0;
      let c: RegExpExecArray | null;
      while ((c = COMPONENT_RE.exec(body)) !== null) {
        const tag = c[0];
        const objectId = Number(/\bobjectid="(\d+)"/.exec(tag)?.[1]);
        if (!Number.isFinite(objectId)) continue;
        const path = /\bp:path="([^"]*)"/.exec(tag)?.[1] ?? /\bpath="([^"]*)"/.exec(tag)?.[1] ?? null;
        components.push({ objectId, path, transform: parseTransform(/\btransform="([^"]*)"/.exec(tag)?.[1]) });
      }
      objects.set(id, { meshXml: meshMatch ? meshMatch[1] : null, components });
    }

    models.set(normalizePath(entry.entryName), { xml, objects });
  }

  return models;
}

interface Accumulator {
  pos: number[];
  idx: number[];
  paint: number[];
  anyPaint: boolean;
}

function appendMesh(acc: Accumulator, meshXml: string, matrix: Affine): void {
  const baseVertex = acc.pos.length / 3;
  const flip = determinant3(matrix) < 0;

  VERTEX_RE.lastIndex = 0;
  let v: RegExpExecArray | null;
  while ((v = VERTEX_RE.exec(meshXml)) !== null) {
    const xm = VX_RE.exec(v[1]);
    const ym = VY_RE.exec(v[1]);
    const zm = VZ_RE.exec(v[1]);
    if (!xm || !ym || !zm) continue;
    const x = Number(xm[1]);
    const y = Number(ym[1]);
    const z = Number(zm[1]);
    acc.pos.push(
      matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
      matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
      matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11]
    );
  }

  TRIANGLE_RE.lastIndex = 0;
  let t: RegExpExecArray | null;
  while ((t = TRIANGLE_RE.exec(meshXml)) !== null) {
    const v1 = T1_RE.exec(t[1]);
    const v2 = T2_RE.exec(t[1]);
    const v3 = T3_RE.exec(t[1]);
    if (!v1 || !v2 || !v3) continue;
    const a = baseVertex + Number(v1[1]);
    const b = baseVertex + Number(v2[1]);
    const c = baseVertex + Number(v3[1]);
    if (flip) acc.idx.push(a, c, b);
    else acc.idx.push(a, b, c);

    const paint = PAINT_ATTR_RE.exec(t[1]);
    if (paint) {
      acc.anyPaint = true;
      acc.paint.push(paintStateToFilamentIndex(decodePaintColor(paint[1])) & 0xff);
    } else {
      acc.paint.push(0);
    }
  }
}

function resolveInto(
  acc: Accumulator,
  models: ReturnType<typeof parseModelEntries>,
  currentPath: string,
  objectId: number,
  matrix: Affine,
  depth: number
): void {
  if (depth > 32) return;
  const model = models.get(currentPath);
  const obj = model?.objects.get(objectId);
  if (!obj) return;

  if (obj.meshXml) appendMesh(acc, obj.meshXml, matrix);
  for (const comp of obj.components) {
    const childPath = comp.path ? normalizePath(comp.path) : currentPath;
    resolveInto(acc, models, childPath, comp.objectId, multiply(matrix, comp.transform), depth + 1);
  }
}

function bakeThreeMf(filePath: string): BakedPart[] | null {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return null;
  }

  const models = parseModelEntries(zip);
  if (models.size === 0) return null;

  const root =
    models.get('/3D/3dmodel.model') ?? [...models.values()].find((m) => ITEM_RE.test(m.xml));
  if (!root) return null;

  const parts: BakedPart[] = [];
  let anyPaintInFile = false;
  const rootPath =
    [...models.entries()].find(([, v]) => v === root)?.[0] ?? '/3D/3dmodel.model';

  ITEM_RE.lastIndex = 0;
  let item: RegExpExecArray | null;
  while ((item = ITEM_RE.exec(root.xml)) !== null) {
    const tag = item[0];
    const objectId = Number(/\bobjectid="(\d+)"/.exec(tag)?.[1]);
    if (!Number.isFinite(objectId)) continue;
    const transform = parseTransform(/\btransform="([^"]*)"/.exec(tag)?.[1]);

    const acc: Accumulator = { pos: [], idx: [], paint: [], anyPaint: false };
    resolveInto(acc, models, rootPath, objectId, transform, 0);
    if (acc.idx.length === 0) continue;

    anyPaintInFile = anyPaintInFile || acc.anyPaint;
    parts.push({
      positions: Float32Array.from(acc.pos),
      indices: Uint32Array.from(acc.idx),
      paint: Uint8Array.from(acc.paint),
    });
  }

  if (parts.length === 0) return null;
  if (!anyPaintInFile) for (const p of parts) p.paint = null;
  return parts;
}

function bakeSoup(filePath: string, ext: string): BakedPart[] | null {
  const pos: number[] = [];
  const found = forEachTriangle(filePath, ext, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  });
  if (!found || pos.length === 0) return null;
  return [{ positions: Float32Array.from(pos), indices: new Uint32Array(0), paint: null }];
}

export function bakeModel(filePath: string, ext: string): BakedPart[] | null {
  const e = ext.toLowerCase();
  if (e === '.3mf') return bakeThreeMf(filePath);
  if (e === '.stl' || e === '.obj') return bakeSoup(filePath, ext);
  return null;
}
