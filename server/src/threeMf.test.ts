import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

// Simulates the real-world "ADM-ZIP: Descriptor data is malformed" crash (a corrupt/
// truncated zip entry with a bad CRC) by making a specific entry's getData() throw.
// adm-zip defines getEntries()/getEntry() on each instance (in its constructor), not on
// the prototype, so this has to go through a module mock rather than vi.spyOn.
const corruptState = vi.hoisted(() => ({ entryName: null as string | null }));

vi.mock('adm-zip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('adm-zip')>();
  // adm-zip's CJS `export =` doesn't type as having `.default`, but esbuild's runtime
  // interop wraps it that way — cast through `any` to bridge the type/runtime mismatch.
  const RealAdmZip = (actual as any).default as new (path?: string) => AdmZip;

  function poison(entry: ReturnType<AdmZip['getEntry']>) {
    if (entry && entry.entryName === corruptState.entryName) {
      entry.getData = () => {
        throw new Error('ADM-ZIP: Descriptor data is malformed');
      };
    }
    return entry;
  }

  // adm-zip assigns getEntries/getEntry as own instance properties inside its constructor
  // (not prototype methods), so `class Patched extends RealAdmZip { getEntry() {...} }`
  // would silently never run — the instance property set by the real constructor shadows
  // the subclass's prototype method. Wrapping the constructed instance directly avoids that.
  function PatchedAdmZip(filePath?: string): AdmZip {
    const real = new RealAdmZip(filePath);

    const originalGetEntries = real.getEntries.bind(real);
    real.getEntries = () => {
      const entries = originalGetEntries();
      entries.forEach(poison);
      return entries;
    };

    const originalGetEntry = real.getEntry.bind(real);
    real.getEntry = (name: string) => poison(originalGetEntry(name));

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
import { extractThreeMfData, listThreeMfImages, groupImagesByPlate, parsePlateSize, computePlateNames } from './threeMf';

const tmpFiles: string[] = [];

function writeFixtureZip(entries: { name: string; content: Buffer | string }[]): string {
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content));
  }
  const filePath = path.join(os.tmpdir(), `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.3mf`);
  zip.writeZip(filePath);
  tmpFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    fs.rmSync(f, { force: true });
  }
});

describe('extractThreeMfData', () => {
  it('extracts the Bambu plate thumbnail and filament/layer metadata', () => {
    const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const settings = {
      filament_type: ['PLA'],
      filament_colour: ['#FF0000'],
      layer_height: ['0.2'],
    };
    const file = writeFixtureZip([
      { name: 'Metadata/plate_1.png', content: pngBytes },
      { name: 'Metadata/project_settings.config', content: JSON.stringify(settings) },
    ]);

    const result = extractThreeMfData(file);

    expect(result.thumbnailBuffer).toEqual(pngBytes);
    expect(result.filamentType).toBe('PLA');
    expect(result.filamentColor).toBe('#FF0000');
    expect(result.layerHeight).toBe('0.2');
    expect(result.rawMetadata).toEqual(settings);
  });

  it('falls back through thumbnail candidates in priority order', () => {
    const topThumb = Buffer.from('top-thumbnail');
    const file = writeFixtureZip([{ name: 'Metadata/top_1.png', content: topThumb }]);

    const result = extractThreeMfData(file);

    expect(result.thumbnailBuffer).toEqual(topThumb);
  });

  it('handles scalar (non-array) settings values', () => {
    const file = writeFixtureZip([
      {
        name: 'Metadata/project_settings.config',
        content: JSON.stringify({ filament_type: 'PETG', layer_height: '0.16' }),
      },
    ]);

    const result = extractThreeMfData(file);

    expect(result.filamentType).toBe('PETG');
    expect(result.layerHeight).toBe('0.16');
  });

  it('returns nulls for a 3mf with no thumbnail or Bambu metadata', () => {
    const file = writeFixtureZip([{ name: 'Metadata/some_other_file.txt', content: 'hello' }]);

    const result = extractThreeMfData(file);

    expect(result.thumbnailBuffer).toBeNull();
    expect(result.filamentType).toBeNull();
    expect(result.filamentColor).toBeNull();
    expect(result.layerHeight).toBeNull();
    expect(result.rawMetadata).toBeNull();
  });

  it('does not throw on a non-zip / corrupt file', () => {
    const filePath = path.join(os.tmpdir(), `corrupt-${Date.now()}.3mf`);
    fs.writeFileSync(filePath, 'not a zip file');
    tmpFiles.push(filePath);

    const result = extractThreeMfData(filePath);

    expect(result.thumbnailBuffer).toBeNull();
    expect(result.rawMetadata).toBeNull();
  });

  it('ignores project_settings.config that is not valid JSON', () => {
    const file = writeFixtureZip([
      { name: 'Metadata/project_settings.config', content: 'not { valid json' },
    ]);

    const result = extractThreeMfData(file);

    expect(result.rawMetadata).toBeNull();
    expect(result.filamentType).toBeNull();
  });

  it('falls through to the next thumbnail candidate when one entry is malformed (regression for ADM-ZIP DESCRIPTOR_FAULTY)', () => {
    const backupThumb = Buffer.from('backup-thumbnail');
    const file = writeFixtureZip([
      { name: 'Metadata/plate_1.png', content: Buffer.from('primary-thumbnail') },
      { name: 'Metadata/plate_no_light_1.png', content: backupThumb },
    ]);

    const result = withCorruptedEntry('Metadata/plate_1.png', () => extractThreeMfData(file));

    expect(result.thumbnailBuffer).toEqual(backupThumb);
  });
});

describe('listThreeMfImages', () => {
  it('lists every image under Metadata/, not just the primary thumbnail candidates', () => {
    const plate = Buffer.from('plate-bytes');
    const top = Buffer.from('top-bytes');
    const pick = Buffer.from('pick-bytes');
    const file = writeFixtureZip([
      { name: 'Metadata/plate_1.png', content: plate },
      { name: 'Metadata/top_1.png', content: top },
      { name: 'Metadata/pick_1.png', content: pick },
      { name: 'Metadata/project_settings.config', content: '{}' }, // non-image, must be excluded
    ]);

    const images = listThreeMfImages(file);

    expect(images).toHaveLength(3);
    expect(images.map((i) => i.name).sort()).toEqual(['pick_1.png', 'plate_1.png', 'top_1.png']);
    expect(images.find((i) => i.name === 'plate_1.png')?.buffer).toEqual(plate);
  });

  it('ignores images outside the Metadata/ folder', () => {
    const file = writeFixtureZip([{ name: 'Textures/decal.png', content: Buffer.from('x') }]);
    expect(listThreeMfImages(file)).toEqual([]);
  });

  it('returns an empty list for a 3mf with no embedded images', () => {
    const file = writeFixtureZip([{ name: 'Metadata/project_settings.config', content: '{}' }]);
    expect(listThreeMfImages(file)).toEqual([]);
  });

  it('does not throw on a non-zip / corrupt file', () => {
    const filePath = path.join(os.tmpdir(), `corrupt-images-${Date.now()}.3mf`);
    fs.writeFileSync(filePath, 'not a zip file');
    tmpFiles.push(filePath);

    expect(listThreeMfImages(filePath)).toEqual([]);
  });

  it('skips a malformed entry and still returns the rest (regression for ADM-ZIP DESCRIPTOR_FAULTY)', () => {
    const goodBuf = Buffer.from('good-bytes');
    const file = writeFixtureZip([
      { name: 'Metadata/good.png', content: goodBuf },
      { name: 'Metadata/bad.png', content: Buffer.from('bad-bytes') },
    ]);

    const images = withCorruptedEntry('Metadata/bad.png', () => listThreeMfImages(file));

    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ name: 'good.png', buffer: goodBuf });
  });
});

describe('groupImagesByPlate', () => {
  it('groups plate/top images by their numeric suffix', () => {
    const plates = groupImagesByPlate(['plate_1.webp', 'top_1.webp', 'plate_2.webp', 'plate_no_light_2.webp']);

    expect(plates).toEqual([
      { index: 1, images: ['plate_1.webp', 'top_1.webp'] },
      { index: 2, images: ['plate_2.webp', 'plate_no_light_2.webp'] },
    ]);
  });

  it('sorts plates ascending by index regardless of input order', () => {
    const plates = groupImagesByPlate(['plate_3.webp', 'plate_1.webp', 'plate_2.webp']);
    expect(plates.map((p) => p.index)).toEqual([1, 2, 3]);
  });

  it('collapses unnumbered images (non-Bambu / single-plate 3MFs) into one implicit plate 1', () => {
    const plates = groupImagesByPlate(['thumbnail_small.webp', 'thumbnail_middle.webp']);

    expect(plates).toEqual([{ index: 1, images: ['thumbnail_small.webp', 'thumbnail_middle.webp'] }]);
  });

  it('returns an empty list for no images', () => {
    expect(groupImagesByPlate([])).toEqual([]);
  });
});

function modelSettingsXml(plates: { platerId: number; name?: string }[]): string {
  const blocks = plates
    .map(
      (p) => `<plate>
    <metadata key="plater_id" value="${p.platerId}"/>
    <metadata key="plater_name" value="${p.name ?? ''}"/>
  </plate>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${blocks}\n</config>`;
}

describe('computePlateNames', () => {
  it('maps plater_id to the human-assigned plate name', () => {
    const file = writeFixtureZip([
      {
        name: 'Metadata/model_settings.config',
        content: modelSettingsXml([
          { platerId: 1, name: 'Body' },
          { platerId: 2, name: 'Eyes' },
        ]),
      },
    ]);

    expect(computePlateNames(file)).toEqual(
      new Map([
        [1, 'Body'],
        [2, 'Eyes'],
      ])
    );
  });

  it('omits plates left unrenamed (empty plater_name)', () => {
    const file = writeFixtureZip([
      {
        name: 'Metadata/model_settings.config',
        content: modelSettingsXml([
          { platerId: 1, name: 'Body' },
          { platerId: 2 }, // no name attr → empty value, same as an unrenamed real plate
        ]),
      },
    ]);

    expect(computePlateNames(file)).toEqual(new Map([[1, 'Body']]));
  });

  it('returns an empty map when there is no model_settings.config (non-Bambu 3MF)', () => {
    const file = writeFixtureZip([{ name: 'Metadata/project_settings.config', content: '{}' }]);
    expect(computePlateNames(file)).toEqual(new Map());
  });

  it('does not throw on a non-zip / corrupt file', () => {
    const filePath = path.join(os.tmpdir(), `corrupt-plate-names-${Date.now()}.3mf`);
    fs.writeFileSync(filePath, 'not a zip file');
    tmpFiles.push(filePath);

    expect(computePlateNames(filePath)).toEqual(new Map());
  });
});

describe('parsePlateSize', () => {
  it('derives the bed footprint from a Bambu printable_area polygon', () => {
    expect(parsePlateSize({ printable_area: ['0x0', '256x0', '256x256', '0x256'] })).toEqual({ x: 256, y: 256 });
  });

  it('supports a non-square bed and a non-zero origin', () => {
    expect(parsePlateSize({ printable_area: ['5x5', '355x5', '355x255', '5x255'] })).toEqual({ x: 350, y: 250 });
  });

  it('falls back to the legacy bed_shape key', () => {
    expect(parsePlateSize({ bed_shape: ['0x0', '250x0', '250x210', '0x210'] })).toEqual({ x: 250, y: 210 });
  });

  it('returns null when no bed key is present or it is unparseable', () => {
    expect(parsePlateSize({ filament_type: ['PLA'] })).toBeNull();
    expect(parsePlateSize({ printable_area: 'nonsense' })).toBeNull();
    expect(parsePlateSize(null)).toBeNull();
  });

  it('is surfaced through extractThreeMfData', () => {
    const file = writeFixtureZip([
      {
        name: 'Metadata/project_settings.config',
        content: JSON.stringify({ printable_area: ['0x0', '180x0', '180x180', '0x180'] }),
      },
    ]);
    expect(extractThreeMfData(file).plateSize).toEqual({ x: 180, y: 180 });
  });
});
