import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

// Simulates the real-world "ADM-ZIP: Descriptor data is malformed" crash (a corrupt/
// truncated zip entry with a bad CRC) by making a specific entry's getData() throw.
// adm-zip assigns getEntries()/getEntry() as own instance properties inside its
// constructor (not prototype methods), so this has to wrap the constructed instance
// directly — subclassing and overriding via `extends` would be silently shadowed.
const corruptState = vi.hoisted(() => ({ entryName: null as string | null }));

vi.mock('adm-zip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('adm-zip')>();
  const RealAdmZip = (actual as any).default as new (path?: string) => AdmZip;

  function poison(entry: ReturnType<AdmZip['getEntry']>) {
    if (entry && entry.entryName === corruptState.entryName) {
      entry.getData = () => {
        throw new Error('ADM-ZIP: Descriptor data is malformed');
      };
    }
    return entry;
  }

  function PatchedAdmZip(filePath?: string): AdmZip {
    const real = new RealAdmZip(filePath);
    const originalGetEntries = real.getEntries.bind(real);
    real.getEntries = () => {
      const entries = originalGetEntries();
      entries.forEach(poison);
      return entries;
    };
    return real;
  }

  return { default: PatchedAdmZip };
});

function withCorruptedEntry<T>(entryName: string, run: () => T): T {
  corruptState.entryName = entryName;
  try {
    return run();
  } finally {
    corruptState.entryName = null;
  }
}

// Vitest hoists vi.mock() calls above all imports in the file, so a normal static
// import here still resolves to the mocked adm-zip.
import { computeDimensions } from './dimensions';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    fs.rmSync(f, { force: true });
  }
});

function writeTmp(name: string, content: Buffer | string): string {
  const filePath = path.join(os.tmpdir(), `dim-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  fs.writeFileSync(filePath, content);
  tmpFiles.push(filePath);
  return filePath;
}

function buildBinaryStl(triangles: [number, number, number][][]): Buffer {
  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.writeUInt32LE(triangles.length, 80);
  let offset = 84;
  for (const tri of triangles) {
    offset += 12; // zeroed normal vector
    for (const [x, y, z] of tri) {
      buf.writeFloatLE(x, offset);
      buf.writeFloatLE(y, offset + 4);
      buf.writeFloatLE(z, offset + 8);
      offset += 12;
    }
    offset += 2; // attribute byte count
  }
  return buf;
}

describe('computeDimensions - STL', () => {
  it('computes dimensions from a binary STL', () => {
    const buf = buildBinaryStl([
      [
        [0, 0, 0],
        [10, 20, 0],
        [0, 0, 5],
      ],
    ]);
    const file = writeTmp('cube.stl', buf);

    const dims = computeDimensions(file, '.stl');

    expect(dims).toEqual({ x: 10, y: 20, z: 5 });
  });

  it('computes dimensions from an ASCII STL', () => {
    const ascii = `solid test
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 15 0 0
    vertex 0 8 3
  endloop
endfacet
endsolid test
`;
    const file = writeTmp('cube-ascii.stl', ascii);

    const dims = computeDimensions(file, '.stl');

    expect(dims).toEqual({ x: 15, y: 8, z: 3 });
  });

  it('is case-insensitive on the extension', () => {
    const buf = buildBinaryStl([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]);
    const file = writeTmp('cube.stl', buf);

    expect(computeDimensions(file, '.STL')).toEqual({ x: 1, y: 1, z: 0 });
  });

  it('returns null for a binary STL with zero triangles', () => {
    const buf = buildBinaryStl([]);
    const file = writeTmp('empty.stl', buf);

    expect(computeDimensions(file, '.stl')).toBeNull();
  });

  it('returns null (not garbage) for a truncated binary STL whose size does not match its header', () => {
    // A valid binary STL, then chopped mid-triangle. Size arithmetic no longer checks out and
    // it doesn't start with "solid" — the parser must NOT reinterpret the binary as ASCII text.
    const buf = buildBinaryStl([
      [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ],
    ]).subarray(0, 100);
    const file = writeTmp('truncated.stl', Buffer.from(buf));

    expect(computeDimensions(file, '.stl')).toBeNull();
  });
});

describe('computeDimensions - OBJ', () => {
  it('computes dimensions from vertex lines, ignoring vt/vn/vp', () => {
    const obj = `
# comment
v 0 0 0
v 12 0 0
v 0 6 0
v 0 0 9
vt 0.5 0.5
vn 0 0 1
vp 0 0
`;
    const file = writeTmp('shape.obj', obj);

    expect(computeDimensions(file, '.obj')).toEqual({ x: 12, y: 6, z: 9 });
  });

  it('returns null for an OBJ with no vertex lines', () => {
    const file = writeTmp('empty.obj', 'vt 0 0\nvn 0 0 1\n');
    expect(computeDimensions(file, '.obj')).toBeNull();
  });
});

describe('computeDimensions - 3MF', () => {
  function writeFixture3mf(xml: string): string {
    const zip = new AdmZip();
    zip.addFile('3D/3dmodel.model', Buffer.from(xml));
    const filePath = path.join(os.tmpdir(), `dim-3mf-${Date.now()}-${Math.random().toString(36).slice(2)}.3mf`);
    zip.writeZip(filePath);
    tmpFiles.push(filePath);
    return filePath;
  }

  it('computes dimensions from vertex elements in the model XML', () => {
    const xml = `<?xml version="1.0"?>
<model>
  <resources>
    <object id="1">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="20" y="0" z="0" />
          <vertex x="0" y="10" z="0" />
          <vertex x="0" y="0" z="4" />
        </vertices>
      </mesh>
    </object>
  </resources>
</model>`;
    const file = writeFixture3mf(xml);

    expect(computeDimensions(file, '.3mf')).toEqual({ x: 20, y: 10, z: 4 });
  });

  it('unions vertices across multiple objects on the same plate', () => {
    const xml = `<model>
  <resources>
    <object id="1"><mesh><vertices>
      <vertex x="0" y="0" z="0" />
      <vertex x="5" y="0" z="0" />
    </vertices></mesh></object>
    <object id="2"><mesh><vertices>
      <vertex x="50" y="0" z="0" />
      <vertex x="55" y="0" z="0" />
    </vertices></mesh></object>
  </resources>
</model>`;
    const file = writeFixture3mf(xml);

    // Raw union of both objects' local vertex coordinates (no per-item transform applied) —
    // matches what the client's full-scene bounding box would show too.
    expect(computeDimensions(file, '.3mf')).toEqual({ x: 55, y: 0, z: 0 });
  });

  it('finds geometry in split part files when the root .model is just a manifest (Bambu/Prusa production extension)', () => {
    // Real Bambu Studio / OrcaSlicer exports keep 3D/3dmodel.model as a thin manifest with
    // <components> referencing separate 3D/Objects/object_N.model part files that hold the
    // actual vertices — this regression-tests that we don't stop at the first .model entry.
    const zip = new AdmZip();
    zip.addFile(
      '3D/3dmodel.model',
      Buffer.from(
        '<model><resources><object id="1"><components>' +
          '<component p:path="/3D/Objects/object_2.model" objectid="1" />' +
          '</components></object></resources></model>'
      )
    );
    zip.addFile(
      '3D/Objects/object_2.model',
      Buffer.from(
        '<model><resources><object id="1"><mesh><vertices>' +
          '<vertex x="0" y="0" z="0" /><vertex x="30" y="0" z="0" />' +
          '<vertex x="0" y="15" z="0" /><vertex x="0" y="0" z="6" />' +
          '</vertices></mesh></object></resources></model>'
      )
    );
    const filePath = path.join(os.tmpdir(), `dim-3mf-split-${Date.now()}.3mf`);
    zip.writeZip(filePath);
    tmpFiles.push(filePath);

    expect(computeDimensions(filePath, '.3mf')).toEqual({ x: 30, y: 15, z: 6 });
  });

  it('returns null when there is no .model entry', () => {
    const zip = new AdmZip();
    zip.addFile('Metadata/plate_1.png', Buffer.from('not a model'));
    const filePath = path.join(os.tmpdir(), `dim-3mf-nomodel-${Date.now()}.3mf`);
    zip.writeZip(filePath);
    tmpFiles.push(filePath);

    expect(computeDimensions(filePath, '.3mf')).toBeNull();
  });

  it('does not throw on a corrupt / non-zip 3mf', () => {
    const file = writeTmp('corrupt.3mf', 'not a zip file');
    expect(computeDimensions(file, '.3mf')).toBeNull();
  });

  it('still finds geometry in a good part file when a sibling part file is malformed (regression for ADM-ZIP DESCRIPTOR_FAULTY)', () => {
    const zip = new AdmZip();
    zip.addFile(
      '3D/Objects/object_bad.model',
      Buffer.from('<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0" /></vertices></mesh></object></resources></model>')
    );
    zip.addFile(
      '3D/Objects/object_good.model',
      Buffer.from(
        '<model><resources><object id="1"><mesh><vertices>' +
          '<vertex x="0" y="0" z="0" /><vertex x="40" y="0" z="0" />' +
          '<vertex x="0" y="9" z="0" /><vertex x="0" y="0" z="2" />' +
          '</vertices></mesh></object></resources></model>'
      )
    );
    const filePath = path.join(os.tmpdir(), `dim-3mf-corrupt-part-${Date.now()}.3mf`);
    zip.writeZip(filePath);
    tmpFiles.push(filePath);

    const dims = withCorruptedEntry('3D/Objects/object_bad.model', () => computeDimensions(filePath, '.3mf'));

    expect(dims).toEqual({ x: 40, y: 9, z: 2 });
  });
});

describe('computeDimensions - misc', () => {
  it('returns null for an unsupported extension', () => {
    const file = writeTmp('model.gltf', '{}');
    expect(computeDimensions(file, '.gltf')).toBeNull();
  });

  it('returns null for a nonexistent file instead of throwing', () => {
    expect(computeDimensions('/nonexistent/path/model.stl', '.stl')).toBeNull();
  });
});
