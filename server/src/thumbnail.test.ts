import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { renderBakedThumbnail } from './thumbnail';
import type { BakedPart } from './meshBake';

// A unit cube as a non-indexed triangle soup (12 triangles, 36 vertices).
function cubeParts(): BakedPart[] {
  const v = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], // bottom
    [4, 6, 5], [4, 7, 6], // top
    [0, 4, 5], [0, 5, 1], // front
    [1, 5, 6], [1, 6, 2], // right
    [2, 6, 7], [2, 7, 3], // back
    [3, 7, 4], [3, 4, 0], // left
  ];
  const positions: number[] = [];
  for (const [a, b, c] of faces) {
    positions.push(...v[a], ...v[b], ...v[c]);
  }
  return [{ positions: Float32Array.from(positions), indices: new Uint32Array(0), paint: null }];
}

describe('renderBakedThumbnail', () => {
  it('renders a 256×256 PNG from a baked cube', async () => {
    const png = await renderBakedThumbnail(cubeParts());
    expect(png).not.toBeNull();
    expect(Array.from(png!.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic

    const meta = await sharp(png!).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
    expect(meta.channels).toBe(4); // has an alpha channel (transparent background)
  });

  it('actually draws the model (some pixels are opaque, some transparent)', async () => {
    const png = await renderBakedThumbnail(cubeParts());
    const { data, info } = await sharp(png!).raw().toBuffer({ resolveWithObject: true });
    let opaque = 0;
    let transparent = 0;
    for (let i = 3; i < data.length; i += info.channels) {
      if (data[i] > 250) opaque++;
      else if (data[i] < 5) transparent++;
    }
    expect(opaque).toBeGreaterThan(500); // the cube covers a meaningful chunk of the frame
    expect(transparent).toBeGreaterThan(500); // ...but not all of it
  });

  it('indexed and non-indexed geometry of the same cube render identically', async () => {
    const soup = cubeParts()[0];
    const indexed: BakedPart = {
      positions: soup.positions,
      indices: Uint32Array.from({ length: soup.positions.length / 3 }, (_, i) => i),
      paint: null,
    };
    const [a, b] = await Promise.all([
      renderBakedThumbnail([soup]),
      renderBakedThumbnail([indexed]),
    ]);
    expect(a!.equals(b!)).toBe(true);
  });

  it('returns null for empty parts or degenerate (zero-size) geometry', async () => {
    expect(await renderBakedThumbnail([])).toBeNull();
    const point: BakedPart = {
      positions: Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      indices: new Uint32Array(0),
      paint: null,
    };
    expect(await renderBakedThumbnail([point])).toBeNull();
  });
});
