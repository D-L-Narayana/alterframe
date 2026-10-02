import { describe, it, expect } from 'vitest';
import { codePrefix, CODE_SUFFIX, PREFIX_PERIOD_MS, buildCode } from '../../../src/hud/code';

describe('codePrefix', () => {
  it('returns a two-digit string with no leading zero', () => {
    for (let t = 0; t < 60_000; t += 137) {
      const p = codePrefix(t, 1);
      expect(p).toMatch(/^[1-9][0-9]$/);
    }
  });

  it('is deterministic for the same slot and seed', () => {
    expect(codePrefix(1234, 7)).toBe(codePrefix(1234, 7));
    expect(codePrefix(0, 7)).toBe(codePrefix(799, 7)); // same 800 ms slot
  });

  it('re-rolls every 800 ms (slot boundaries)', () => {
    expect(PREFIX_PERIOD_MS).toBe(800);
    // Across many consecutive slots the value must change at least once; a hash
    // may collide on a single boundary, so we assert on a window of slots.
    const values = new Set<string>();
    for (let slot = 0; slot < 12; slot++) values.add(codePrefix(slot * 800, 3));
    expect(values.size).toBeGreaterThan(4);
  });

  it('changes with the seed', () => {
    const a = Array.from({ length: 10 }, (_, i) => codePrefix(i * 800, 1)).join(',');
    const b = Array.from({ length: 10 }, (_, i) => codePrefix(i * 800, 2)).join(',');
    expect(a).not.toBe(b);
  });

  it('handles negative or non-finite t gracefully', () => {
    expect(codePrefix(-100, 1)).toMatch(/^[1-9][0-9]$/);
    expect(codePrefix(Number.NaN, 1)).toMatch(/^[1-9][0-9]$/);
  });
});

describe('buildCode', () => {
  it('concatenates prefix with the fixed anchor suffixes', () => {
    expect(CODE_SUFFIX.corner).toBe('10100');
    expect(CODE_SUFFIX['eye-left']).toBe('10301');
    expect(CODE_SUFFIX['eye-right']).toBe('10502');
    const code = buildCode('16', 'corner');
    expect(code).toBe('1610100');
    expect(code).toHaveLength(7);
  });
});
