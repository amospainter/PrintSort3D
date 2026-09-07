import { describe, it, expect } from 'vitest';
import { TAG_COLOR_PRESETS, resolveTagColor, tagChipStyle, tagColorMap } from './tagColors';

describe('resolveTagColor', () => {
  it('returns the explicit colour verbatim when one is set', () => {
    expect(resolveTagColor('anything', '#123456')).toBe('#123456');
  });

  it('falls back to a preset picked deterministically by name hash', () => {
    const a = resolveTagColor('calibration', null);
    const b = resolveTagColor('calibration', undefined);
    expect(a).toBe(b);
    expect(TAG_COLOR_PRESETS).toContain(a as (typeof TAG_COLOR_PRESETS)[number]);
  });

  it('spreads different names across more than one preset', () => {
    const names = ['a', 'b', 'c', 'vase', 'toy', 'mount', 'gasket', 'benchy', 'gear', 'clip'];
    const used = new Set(names.map((n) => resolveTagColor(n, null)));
    expect(used.size).toBeGreaterThan(1);
  });

  it('treats an empty string as "no explicit colour"', () => {
    expect(resolveTagColor('x', '')).toBe(resolveTagColor('x', null));
  });
});

describe('tagChipStyle', () => {
  it('pairs a light background with dark text and a dark background with light text', () => {
    expect(tagChipStyle('t', '#ffffff').color).toBe('#1a1a1a');
    expect(tagChipStyle('t', '#000000').color).toBe('#ffffff');
  });

  it('expands 3-digit hex before computing contrast', () => {
    expect(tagChipStyle('t', '#fff').color).toBe('#1a1a1a');
  });

  it('defaults text to white for an unparseable colour', () => {
    expect(tagChipStyle('t', 'rebeccapurple').color).toBe('#fff');
  });
});

describe('tagColorMap', () => {
  it('maps tag name to its explicit colour (null preserved)', () => {
    const map = tagColorMap([
      { name: 'red', color: '#ff0000', count: 3 },
      { name: 'auto', color: null, count: 1 },
    ]);
    expect(map.get('red')).toBe('#ff0000');
    expect(map.get('auto')).toBeNull();
    expect(map.has('missing')).toBe(false);
  });
});
