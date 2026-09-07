import fs from 'fs';
import AdmZip from 'adm-zip';

export type VertexCallback = (x: number, y: number, z: number) => void;
export type TriangleCallback = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number
) => void;

const ASCII_VERTEX_RE = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;

function walkStlVertices(buffer: Buffer, onVertex: VertexCallback): boolean {
  let found = false;

  // A binary STL is exactly 84 + 50*triangleCount bytes. If that arithmetic checks out,
  // trust it's binary; otherwise fall back to the ASCII "vertex x y z" text format
  // (some binary STLs also start with the bytes "solid", so size is the reliable signal).
  if (buffer.length >= 84) {
    const triangleCount = buffer.readUInt32LE(80);
    const expectedBinarySize = 84 + triangleCount * 50;
    if (expectedBinarySize === buffer.length) {
      for (let i = 0; i < triangleCount; i++) {
        const base = 84 + i * 50 + 12; // skip the 12-byte normal vector
        for (let v = 0; v < 3; v++) {
          const offset = base + v * 12;
          onVertex(buffer.readFloatLE(offset), buffer.readFloatLE(offset + 4), buffer.readFloatLE(offset + 8));
          found = true;
        }
      }
      return found;
    }
  }

  const text = buffer.toString('utf-8');
  let match: RegExpExecArray | null;
  ASCII_VERTEX_RE.lastIndex = 0;
  while ((match = ASCII_VERTEX_RE.exec(text)) !== null) {
    onVertex(Number(match[1]), Number(match[2]), Number(match[3]));
    found = true;
  }
  return found;
}

function walkObjVertices(buffer: Buffer, onVertex: VertexCallback): boolean {
  let found = false;
  const text = buffer.toString('utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // "v x y z" — a vertex position line. Excludes "vt" (texcoord), "vn" (normal), "vp".
    if (!/^v\s/.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    onVertex(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    found = true;
  }
  return found;
}

const XML_VERTEX_TAG_RE = /<vertex\b([^>]*)\/>/gi;
// "-" must be inside the class (not just an optional prefix) to keep negative exponents
// like "1.5e-05" intact — otherwise Number() sees "1.5e" and returns NaN.
const XML_ATTR_RE = /([xyz])="([-\d.eE+]+)"/g;

function walkThreeMfVertices(filePath: string, onVertex: VertexCallback): boolean {
  let found = false;
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return false;
  }

  // Bambu Studio / PrusaSlicer (3MF Production Extension) split geometry across multiple
  // part files — the root 3D/3dmodel.model is often just a thin manifest of <components>
  // referencing 3D/Objects/object_N.model for the actual vertices. Union across every
  // .model entry in the archive rather than assuming the root file has the geometry.
  const modelEntries = zip.getEntries().filter((e) => /\.model$/i.test(e.entryName));
  if (modelEntries.length === 0) return false;

  for (const entry of modelEntries) {
    let xml: string;
    try {
      xml = entry.getData().toString('utf-8');
    } catch {
      // A single malformed part file (bad CRC/descriptor) shouldn't block reading
      // geometry from the rest of the 3MF's part files — skip it.
      continue;
    }
    let tagMatch: RegExpExecArray | null;
    XML_VERTEX_TAG_RE.lastIndex = 0;
    while ((tagMatch = XML_VERTEX_TAG_RE.exec(xml)) !== null) {
      const attrs = tagMatch[1];
      const coords: Record<string, number> = {};
      let attrMatch: RegExpExecArray | null;
      XML_ATTR_RE.lastIndex = 0;
      while ((attrMatch = XML_ATTR_RE.exec(attrs)) !== null) {
        coords[attrMatch[1]] = Number(attrMatch[2]);
      }
      if ('x' in coords && 'y' in coords && 'z' in coords) {
        onVertex(coords.x, coords.y, coords.z);
        found = true;
      }
    }
  }
  return found;
}

function walkStlTriangles(buffer: Buffer, onTri: TriangleCallback): boolean {
  let found = false;

  if (buffer.length >= 84) {
    const triangleCount = buffer.readUInt32LE(80);
    if (84 + triangleCount * 50 === buffer.length) {
      for (let i = 0; i < triangleCount; i++) {
        const base = 84 + i * 50 + 12; // skip the 12-byte normal vector
        onTri(
          buffer.readFloatLE(base),
          buffer.readFloatLE(base + 4),
          buffer.readFloatLE(base + 8),
          buffer.readFloatLE(base + 12),
          buffer.readFloatLE(base + 16),
          buffer.readFloatLE(base + 20),
          buffer.readFloatLE(base + 24),
          buffer.readFloatLE(base + 28),
          buffer.readFloatLE(base + 32)
        );
        found = true;
      }
      return found;
    }
  }

  // ASCII: collect vertices in "facet ... outer loop / vertex*3 / endloop" order, three at a time.
  const text = buffer.toString('utf-8');
  const coords: number[] = [];
  let match: RegExpExecArray | null;
  ASCII_VERTEX_RE.lastIndex = 0;
  while ((match = ASCII_VERTEX_RE.exec(text)) !== null) {
    coords.push(Number(match[1]), Number(match[2]), Number(match[3]));
    if (coords.length === 9) {
      onTri(coords[0], coords[1], coords[2], coords[3], coords[4], coords[5], coords[6], coords[7], coords[8]);
      coords.length = 0;
      found = true;
    }
  }
  return found;
}

function walkObjTriangles(buffer: Buffer, onTri: TriangleCallback): boolean {
  const text = buffer.toString('utf-8');
  const verts: [number, number, number][] = [];
  let found = false;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^v\s/.test(trimmed)) {
      const p = trimmed.split(/\s+/);
      if (p.length >= 4) verts.push([Number(p[1]), Number(p[2]), Number(p[3])]);
      continue;
    }
    if (!/^f\s/.test(trimmed)) continue;

    // "f a b c [d ...]" — each token is v, v/vt, v//vn or v/vt/vn; indices are 1-based and
    // may be negative (relative to the vertices seen so far). Fan-triangulate polygons.
    const refs = trimmed
      .split(/\s+/)
      .slice(1)
      .map((tok) => {
        const raw = Number(tok.split('/')[0]);
        return raw < 0 ? verts.length + raw : raw - 1;
      })
      .filter((i) => i >= 0 && i < verts.length);
    for (let i = 1; i + 1 < refs.length; i++) {
      const a = verts[refs[0]];
      const b = verts[refs[i]];
      const c = verts[refs[i + 1]];
      onTri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      found = true;
    }
  }
  return found;
}

/**
 * Walks every triangle (three vertex positions) of an STL or OBJ file. Unlike forEachVertex
 * this needs face/topology info, so it's STL/OBJ only — 3MF triangle extraction lives in
 * meshBake.ts, where the build-graph transform resolution it needs also lives. Returns
 * whether any triangle was found.
 */
export function forEachTriangle(filePath: string, ext: string, onTri: TriangleCallback): boolean {
  const normalizedExt = ext.toLowerCase();
  try {
    if (normalizedExt === '.stl') return walkStlTriangles(fs.readFileSync(filePath), onTri);
    if (normalizedExt === '.obj') return walkObjTriangles(fs.readFileSync(filePath), onTri);
  } catch {
    return false;
  }
  return false;
}

/**
 * Walks every vertex position in an STL/OBJ/3MF file, invoking `onVertex` for each,
 * without building any in-memory mesh/geometry representation. Shared by dimension
 * computation (bounding box) and geometry fingerprinting (duplicate detection) so the
 * per-format parsing (binary/ASCII STL detection, OBJ "v " lines, multi-part-file 3MF
 * union) lives in exactly one place. Returns whether any vertex was found.
 */
export function forEachVertex(filePath: string, ext: string, onVertex: VertexCallback): boolean {
  const normalizedExt = ext.toLowerCase();
  try {
    if (normalizedExt === '.stl') return walkStlVertices(fs.readFileSync(filePath), onVertex);
    if (normalizedExt === '.obj') return walkObjVertices(fs.readFileSync(filePath), onVertex);
    if (normalizedExt === '.3mf') return walkThreeMfVertices(filePath, onVertex);
  } catch {
    return false;
  }
  return false;
}
