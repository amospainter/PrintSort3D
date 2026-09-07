import sharp from 'sharp';
import type { BakedPart } from './meshBake';

/**
 * CPU-only thumbnail renderer for STL / OBJ / non-Bambu 3MF models.
 *
 * We deliberately do NOT use WebGL / three.js here — the server frequently runs in a
 * headless Docker container with no GPU or display. This is a tiny software rasterizer
 * (z-buffered, flat two-sided Lambert shading) that draws the already-baked mesh
 * (`meshBake.ts` → `BakedPart[]`) straight into an RGBA pixel buffer, which `sharp` then
 * encodes to PNG. Rendered at 2× and downscaled for cheap antialiasing.
 *
 * The camera framing and lighting mirror the in-browser viewer
 * (`client/src/loadModel.ts` `frameObject` + `ModelViewer`'s lights) so a catalogued
 * file's thumbnail reads the same as opening it.
 */

const OUT_SIZE = 256;
const SSAA = 2; // render at OUT_SIZE * SSAA, downscale for antialiasing
const RENDER_SIZE = OUT_SIZE * SSAA;
const FOV_DEG = 45;

// Base filament-less model grey, matched to the viewer's default material (0x9a9a9a).
const BASE = [0x9a, 0x9a, 0x9a];
// Lights, matched to ModelViewer.tsx (ambient 0.6, key dir 1.2 @ (5,8,5), fill 0.3 @ (-5,-3,-5)).
const AMBIENT = 0.6;
const KEY_DIR = normalize([5, 8, 5]);
const KEY_INT = 1.2;
const FILL_DIR = normalize([-5, -3, -5]);
const FILL_INT = 0.3;

type V3 = [number, number, number];

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

interface Bounds {
  min: V3;
  max: V3;
}

function computeBounds(parts: BakedPart[]): Bounds | null {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const part of parts) {
    const p = part.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
      any = true;
    }
  }
  return any ? { min, max } : null;
}

/**
 * Renders a PNG thumbnail (OUT_SIZE × OUT_SIZE, transparent background) of the baked mesh.
 * Returns null if the mesh has no usable geometry.
 */
export async function renderBakedThumbnail(parts: BakedPart[]): Promise<Buffer | null> {
  const bounds = computeBounds(parts);
  if (!bounds) return null;

  const size: V3 = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const center: V3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const maxDim = Math.max(size[0], size[1], size[2]);
  if (!(maxDim > 0)) return null;

  // Framing mirrors frameObject(): fit the model, then pull back 1.6×, viewed from a low
  // mostly head-on angle with Z up.
  const tanHalfFov = Math.tan((FOV_DEG * Math.PI) / 360);
  const fitDistance = maxDim / (2 * tanHalfFov);
  // Tighter than the interactive viewer's 1.6× — a thumbnail has no bed to keep in frame
  // and should fill its card.
  const distance = fitDistance * 1.32;
  const near = distance / 100;

  const camPos: V3 = [distance * 0.32, -distance * 0.92, distance * 0.42];
  const forward = normalize(sub([0, 0, 0], camPos)); // look at the (recentered) origin
  const right = normalize(cross(forward, [0, 0, 1]));
  const up = cross(right, forward);

  const W = RENDER_SIZE;
  const H = RENDER_SIZE;
  const rgba = Buffer.alloc(W * H * 4); // zero = transparent
  const depth = new Float32Array(W * H).fill(Infinity);

  // Project one recentered world-space vertex to screen space + view depth.
  const project = (wx: number, wy: number, wz: number) => {
    const rel: V3 = [wx - center[0] - camPos[0], wy - center[1] - camPos[1], wz - center[2] - camPos[2]];
    const vx = dot(rel, right);
    const vy = dot(rel, up);
    const vz = dot(rel, forward); // +ve in front of the camera
    if (vz <= near) return null;
    const ndcX = vx / (vz * tanHalfFov);
    const ndcY = vy / (vz * tanHalfFov);
    return {
      sx: (ndcX * 0.5 + 0.5) * W,
      sy: (1 - (ndcY * 0.5 + 0.5)) * H,
      vz,
    };
  };

  const shade = (n: V3): number => {
    // Two-sided: abs() so open / inward-facing meshes still light instead of going black.
    const i = AMBIENT + KEY_INT * Math.abs(dot(n, KEY_DIR)) + FILL_INT * Math.abs(dot(n, FILL_DIR));
    return Math.min(1, i);
  };

  const drawTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    color: V3
  ) => {
    const nWorld = normalize(cross(sub([bx, by, bz], [ax, ay, az]), sub([cx, cy, cz], [ax, ay, az])));
    const lum = shade(nWorld);
    const r = Math.round(color[0] * lum);
    const g = Math.round(color[1] * lum);
    const bl = Math.round(color[2] * lum);

    const pa = project(ax, ay, az);
    const pb = project(bx, by, bz);
    const pc = project(cx, cy, cz);
    if (!pa || !pb || !pc) return; // any vertex behind the near plane → skip (thumbnail-grade)

    const minX = Math.max(0, Math.floor(Math.min(pa.sx, pb.sx, pc.sx)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(pa.sx, pb.sx, pc.sx)));
    const minY = Math.max(0, Math.floor(Math.min(pa.sy, pb.sy, pc.sy)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(pa.sy, pb.sy, pc.sy)));
    if (minX > maxX || minY > maxY) return;

    const area = (pb.sx - pa.sx) * (pc.sy - pa.sy) - (pb.sy - pa.sy) * (pc.sx - pa.sx);
    if (Math.abs(area) < 1e-9) return;
    const invArea = 1 / area;

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((pb.sx - px) * (pc.sy - py) - (pb.sy - py) * (pc.sx - px)) * invArea;
        const w1 = ((pc.sx - px) * (pa.sy - py) - (pc.sy - py) * (pa.sx - px)) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const vz = w0 * pa.vz + w1 * pb.vz + w2 * pc.vz;
        const di = y * W + x;
        if (vz >= depth[di]) continue;
        depth[di] = vz;
        const oi = di * 4;
        rgba[oi] = r;
        rgba[oi + 1] = g;
        rgba[oi + 2] = bl;
        rgba[oi + 3] = 255;
      }
    }
  };

  for (const part of parts) {
    const p = part.positions;
    const idx = part.indices;
    const triCount = idx.length > 0 ? idx.length / 3 : p.length / 9;
    for (let t = 0; t < triCount; t++) {
      let ia: number, ib: number, ic: number;
      if (idx.length > 0) {
        ia = idx[t * 3] * 3;
        ib = idx[t * 3 + 1] * 3;
        ic = idx[t * 3 + 2] * 3;
      } else {
        ia = t * 9;
        ib = t * 9 + 3;
        ic = t * 9 + 6;
      }
      drawTri(
        p[ia], p[ia + 1], p[ia + 2],
        p[ib], p[ib + 1], p[ib + 2],
        p[ic], p[ic + 1], p[ic + 2],
        BASE as V3
      );
    }
  }

  try {
    return await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
      .resize(OUT_SIZE, OUT_SIZE)
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}
