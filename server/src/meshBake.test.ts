import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { bakeModel } from './meshBake';

const tmpFiles: string[] = [];
function tmp(name: string): string {
  const p = path.join(os.tmpdir(), `bake-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

function meshXml(objectId: number, verts: [number, number, number][], tris: { v: [number, number, number]; paint?: string }[]): string {
  const v = verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const t = tris
    .map((tr) => `<triangle v1="${tr.v[0]}" v2="${tr.v[1]}" v3="${tr.v[2]}"${tr.paint ? ` paint_color="${tr.paint}"` : ''}/>`)
    .join('');
  return `<object id="${objectId}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
}

function write3mf(entries: { name: string; content: string }[]): string {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, Buffer.from(e.content));
  const p = tmp('model.3mf');
  zip.writeZip(p);
  return p;
}

const CUBE_VERTS: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

describe('bakeModel — 3MF', () => {
  it('applies the build-item transform to vertices and folds in per-triangle paint', () => {
    const file = write3mf([
      {
        name: '3D/3dmodel.model',
        content:
          '<model><resources>' +
          '<object id="2" type="model"><components><component objectid="1" p:path="/3D/Objects/object_1.model"/></components></object>' +
          '</resources><build><item objectid="2" transform="2 0 0 0 2 0 0 0 2 0 0 0"/></build></model>',
      },
      {
        name: '3D/Objects/object_1.model',
        content:
          '<model><resources>' +
          meshXml(1, CUBE_VERTS, [
            { v: [0, 1, 2], paint: '8' }, // state 2 -> slot 1
            { v: [0, 1, 3], paint: '1C' }, // state 4 -> slot 3
            { v: [1, 2, 3] }, // unpainted -> slot 0
          ]) +
          '</resources></model>',
      },
    ]);

    const parts = bakeModel(file, '.3mf');
    expect(parts).toHaveLength(1);
    const [p] = parts!;
    // 4 vertices, each scaled ×2
    expect(Array.from(p.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2]);
    expect(Array.from(p.indices)).toEqual([0, 1, 2, 0, 1, 3, 1, 2, 3]);
    expect(Array.from(p.paint!)).toEqual([1, 3, 0]);
  });

  it('emits one part per <build><item>, in document order', () => {
    const obj = (id: number, n: number) =>
      meshXml(
        id,
        CUBE_VERTS,
        Array.from({ length: n }, () => ({ v: [0, 1, 2] as [number, number, number] }))
      );
    const file = write3mf([
      {
        name: '3D/3dmodel.model',
        content:
          `<model><resources>${obj(1, 1)}${obj(2, 2)}</resources>` +
          '<build><item objectid="1"/><item objectid="2"/></build></model>',
      },
    ]);

    const parts = bakeModel(file, '.3mf')!;
    expect(parts.map((p) => p.indices.length / 3)).toEqual([1, 2]);
  });

  it('leaves paint null when no triangle in the file is painted', () => {
    const file = write3mf([
      {
        name: '3D/3dmodel.model',
        content:
          `<model><resources>${meshXml(1, CUBE_VERTS, [{ v: [0, 1, 2] }])}</resources>` +
          '<build><item objectid="1"/></build></model>',
      },
    ]);
    expect(bakeModel(file, '.3mf')![0].paint).toBeNull();
  });

  it('reverses winding for a mirrored (negative-determinant) transform', () => {
    const file = write3mf([
      {
        name: '3D/3dmodel.model',
        content:
          `<model><resources>${meshXml(1, CUBE_VERTS, [{ v: [0, 1, 2] }])}</resources>` +
          '<build><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>',
      },
    ]);
    expect(Array.from(bakeModel(file, '.3mf')![0].indices)).toEqual([0, 2, 1]);
  });

  it('returns null for a corrupt / non-zip file', () => {
    const p = tmp('bad.3mf');
    fs.writeFileSync(p, 'not a zip');
    expect(bakeModel(p, '.3mf')).toBeNull();
  });
});

describe('bakeModel — STL / OBJ', () => {
  function binaryStl(triangles: number[][]): Buffer {
    const buf = Buffer.alloc(84 + triangles.length * 50);
    buf.writeUInt32LE(triangles.length, 80);
    triangles.forEach((tri, i) => {
      let off = 84 + i * 50 + 12;
      for (const c of tri) {
        buf.writeFloatLE(c, off);
        off += 4;
      }
    });
    return buf;
  }

  it('bakes a binary STL into a non-indexed triangle soup', () => {
    const p = tmp('m.stl');
    fs.writeFileSync(p, binaryStl([[0, 0, 0, 1, 0, 0, 0, 1, 0], [1, 1, 1, 2, 1, 1, 1, 2, 1]]));
    const parts = bakeModel(p, '.stl')!;
    expect(parts).toHaveLength(1);
    expect(parts[0].indices.length).toBe(0);
    expect(Array.from(parts[0].positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 2, 1, 1, 1, 2, 1]);
    expect(parts[0].paint).toBeNull();
  });

  it('bakes an ASCII STL', () => {
    const p = tmp('m.stl');
    fs.writeFileSync(
      p,
      `solid s
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid s`
    );
    const parts = bakeModel(p, '.stl')!;
    expect(Array.from(parts[0].positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('fan-triangulates OBJ polygons and handles v/vt/vn face indices', () => {
    const p = tmp('m.obj');
    fs.writeFileSync(
      p,
      `v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vn 0 0 1
f 1/1/1 2/1/1 3/1/1 4/1/1`
    );
    const parts = bakeModel(p, '.obj')!;
    // quad -> 2 triangles -> 18 floats
    expect(parts[0].positions.length).toBe(18);
    expect(Array.from(parts[0].positions.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
  });

  it('returns null for an OBJ with no faces', () => {
    const p = tmp('pc.obj');
    fs.writeFileSync(p, 'v 0 0 0\nv 1 1 1\n');
    expect(bakeModel(p, '.obj')).toBeNull();
  });
});
