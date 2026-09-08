import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { extractF3dThumbnail } from './f3d';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

function writeF3d(entries: { name: string; content: Buffer | string }[]): string {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content));
  const p = path.join(os.tmpdir(), `f3d-test-${Date.now()}-${Math.random().toString(36).slice(2)}.f3d`);
  zip.writeZip(p);
  tmpFiles.push(p);
  return p;
}

const SMALL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

describe('extractF3dThumbnail', () => {
  it('pulls the preview PNG out of a Fusion archive', () => {
    const f = writeF3d([
      { name: 'Manifest.dat', content: 'binary manifest' },
      { name: 'FusionAssetName[Active]/Breps.BlobParts/BREP.abc.smb', content: 'proprietary brep' },
      { name: 'FusionAssetName[Active]/Previews/small.png', content: SMALL_PNG },
    ]);
    expect(extractF3dThumbnail(f)).toEqual(SMALL_PNG);
  });

  it('prefers the largest image under Previews/ and ignores appearance textures', () => {
    const big = Buffer.concat([SMALL_PNG, Buffer.alloc(500)]);
    const f = writeF3d([
      { name: 'FusionAssetName[Active]/Images.BlobParts/Image.xyz.png', content: Buffer.alloc(9999) },
      { name: 'FusionAssetName[Active]/Previews/small.png', content: SMALL_PNG },
      { name: 'FusionAssetName[Active]/Previews/large.png', content: big },
    ]);
    expect(extractF3dThumbnail(f)).toEqual(big);
  });

  it('returns null when there is no preview, and for a non-zip file', () => {
    const noPreview = writeF3d([{ name: 'Manifest.dat', content: 'x' }]);
    expect(extractF3dThumbnail(noPreview)).toBeNull();

    const corrupt = path.join(os.tmpdir(), `f3d-corrupt-${Date.now()}.f3d`);
    fs.writeFileSync(corrupt, 'not a zip');
    tmpFiles.push(corrupt);
    expect(extractF3dThumbnail(corrupt)).toBeNull();
  });
});
