/**
 * Decoder for the per-triangle `paint_color` attribute Bambu Studio / OrcaSlicer / PrusaSlicer
 * write onto each `<triangle>` of a painted (multi-material / AMS) 3MF.
 *
 * Consumed by `meshBake.ts`, which folds the decoded per-triangle filament slots into the
 * baked render mesh. Clean-room reimplementation from the wire format only — PrusaSlicer's
 * reference implementation (`FacetsAnnotation::set_triangle_from_string` +
 * `TriangleSelector::deserialize`) is AGPL and is NOT copied here. Format, verified against a
 * real 4-color Bambu export:
 *
 *   - Each attribute string is one triangle's complete, self-contained split-tree.
 *   - Read the hex string RIGHT-TO-LEFT; each hex digit is 4 bits LSB-first; concatenate
 *     into a bitstream. `nibble()` consumes 4 bits as `n |= bit[i] << i`.
 *   - Per node: `code = nibble()`, `splitSides = code & 0b11`.
 *       splitSides === 0 → leaf. If `(code & 0b1100) === 0b1100` the state is extended:
 *         `state = nibble() + 3`; otherwise `state = code >> 2`.
 *       splitSides  >  0 → `splitSides + 1` children, each parsed recursively. (`code >> 2`
 *         is the "special side" index, irrelevant to colour.)
 *   - `state` is the 1-based extruder number (Orca's `EnforcerBlockerType`: Extruder1 = 1),
 *     so the filament slot index is `state - 1`. A triangle with no attribute at all uses
 *     the base filament (index 0).
 *
 * We only need a single colour per original triangle, so a split triangle is approximated by
 * its dominant (most frequent) leaf state — full midpoint subdivision is a later follow-up.
 */

const HEX = /^[0-9a-fA-F]*$/;

/**
 * Returns the dominant leaf state (1-based extruder number) encoded by a `paint_color` string,
 * or 0 for an empty / malformed value (caller treats 0 as "base filament").
 */
export function decodePaintColor(attr: string): number {
  if (!attr || !HEX.test(attr)) return 0;

  // Bitstream: string reversed, each hex digit expanded LSB-first.
  const bits: number[] = [];
  for (let i = attr.length - 1; i >= 0; i--) {
    const dec = parseInt(attr[i], 16);
    bits.push(dec & 1, (dec >> 1) & 1, (dec >> 2) & 1, (dec >> 3) & 1);
  }

  let pos = 0;
  const nibble = (): number => {
    const n = (bits[pos] ?? 0) | ((bits[pos + 1] ?? 0) << 1) | ((bits[pos + 2] ?? 0) << 2) | ((bits[pos + 3] ?? 0) << 3);
    pos += 4;
    return n;
  };

  const counts = new Map<number, number>();
  let overran = false;

  const walk = (depth: number): void => {
    if (pos + 4 > bits.length || depth > 64) {
      overran = true;
      return;
    }
    const code = nibble();
    const splitSides = code & 0b11;
    if (splitSides === 0) {
      const state = (code & 0b1100) === 0b1100 ? nibble() + 3 : code >> 2;
      counts.set(state, (counts.get(state) ?? 0) + 1);
      return;
    }
    const children = splitSides + 1;
    for (let c = 0; c < children && !overran; c++) walk(depth + 1);
  };

  walk(0);
  if (counts.size === 0) return 0;

  // Most frequent leaf state; ties broken toward the smaller state for determinism.
  let best = -1;
  let bestCount = -1;
  for (const [state, count] of counts) {
    if (count > bestCount || (count === bestCount && state < best)) {
      best = state;
      bestCount = count;
    }
  }
  return best;
}

/** 1-based extruder state → 0-based filament-slot index (base filament when state <= 0). */
export function paintStateToFilamentIndex(state: number): number {
  return state > 0 ? state - 1 : 0;
}
