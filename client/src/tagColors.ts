import type { TagInfo } from './api';

// Preset tag colours offered in Settings (plus a free "custom" <input type="color"> in the
// UI). Kept deliberately muted so a row of chips doesn't overwhelm the card it sits on.
export const TAG_COLOR_PRESETS = [
  '#4a90e2', // blue
  '#50b083', // green
  '#e2a23b', // amber
  '#d9644a', // red-orange
  '#9b6bd6', // purple
  '#3bb0b0', // teal
  '#d36ba0', // pink
  '#7a8794', // slate
] as const;

// A tag with no explicit colour gets a stable one picked from the presets by hashing its
// name, so the catalog still reads as colour-coded before anyone visits Settings.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function resolveTagColor(name: string, explicit: string | null | undefined): string {
  if (explicit) return explicit;
  return TAG_COLOR_PRESETS[hashString(name) % TAG_COLOR_PRESETS.length];
}

// Relative luminance (sRGB) → pick black or white text for contrast on the chip.
function readableTextColor(hex: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.5 ? '#1a1a1a' : '#ffffff';
}

export interface TagChipStyle {
  backgroundColor: string;
  color: string;
}

export function tagChipStyle(name: string, explicit: string | null | undefined): TagChipStyle {
  const bg = resolveTagColor(name, explicit);
  return { backgroundColor: bg, color: readableTextColor(bg) };
}

// Builds a name→explicit-colour lookup from a /api/tags response for chip rendering.
export function tagColorMap(tags: TagInfo[]): Map<string, string | null> {
  return new Map(tags.map((t) => [t.name, t.color]));
}
