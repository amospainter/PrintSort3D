import fs from 'fs';
import AdmZip from 'adm-zip';

export type VertexCallback = (x: number, y: number, z: number) => void;

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
const XML_ATTR_RE = /([xyz])="(-?[\d.eE+]+)"/g;

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
