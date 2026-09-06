import { describe, it, expect } from 'vitest';
import { decodePaintColor, paintStateToFilamentIndex } from './paintColor';

describe('decodePaintColor', () => {
  it('decodes the simple (non-extended) leaf states', () => {
    // Verified against a real 4-colour Bambu export: "4" -> extruder 1, "8" -> extruder 2.
    expect(decodePaintColor('4')).toBe(1);
    expect(decodePaintColor('8')).toBe(2);
  });

  it('decodes extended (>= 3) leaf states from the two-nibble encoding', () => {
    // "0C" -> extruder 3, "1C" -> extruder 4 (both verified against the bear file).
    expect(decodePaintColor('0C')).toBe(3);
    expect(decodePaintColor('1C')).toBe(4);
  });

  it('is case-insensitive', () => {
    expect(decodePaintColor('1c')).toBe(4);
  });

  it('collapses a split triangle to its dominant leaf state', () => {
    // 3-way split whose four children are all extended state 4.
    expect(decodePaintColor('1C1C1C1C3')).toBe(4);
  });

  it('picks the most frequent leaf state for a mixed split', () => {
    // "3" = 3-way split (4 children); children (reverse order in the stream) are
    // "8" "8" "8" "4" -> states 2,2,2,1 -> dominant 2.
    expect(decodePaintColor('48883')).toBe(2);
  });

  it('returns 0 (base filament) for empty or malformed input', () => {
    expect(decodePaintColor('')).toBe(0);
    expect(decodePaintColor('xyz')).toBe(0);
  });
});

describe('paintStateToFilamentIndex', () => {
  it('maps the 1-based extruder state to a 0-based filament slot', () => {
    expect(paintStateToFilamentIndex(1)).toBe(0);
    expect(paintStateToFilamentIndex(4)).toBe(3);
  });

  it('clamps non-positive states to the base filament', () => {
    expect(paintStateToFilamentIndex(0)).toBe(0);
    expect(paintStateToFilamentIndex(-1)).toBe(0);
  });
});
