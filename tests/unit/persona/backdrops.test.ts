import { describe, it, expect } from 'vitest';
import { generateSkyline, SKYLINE, parallaxOffset } from '../../../src/render/persona/backdrops';

describe('night-city skyline data', () => {
  it('generates between 12 and 18 skyscrapers per layer, deterministically from the seed', () => {
    const a = generateSkyline(7, 'near');
    const b = generateSkyline(7, 'near');
    expect(a).toEqual(b);
    const total = generateSkyline(7, 'far').length + a.length;
    expect(total).toBeGreaterThanOrEqual(12);
    expect(total).toBeLessThanOrEqual(18);
    for (const bld of a) {
      expect(bld.x).toBeGreaterThanOrEqual(0); expect(bld.x).toBeLessThan(1);
      expect(bld.w).toBeGreaterThan(0); expect(bld.h).toBeGreaterThan(0); expect(bld.h).toBeLessThan(1);
      expect(bld.windows.length).toBeGreaterThan(0);
    }
  });
  it('different seeds give different skylines', () => {
    expect(generateSkyline(1, 'near')).not.toEqual(generateSkyline(2, 'near'));
  });
  it('parallax drift is slow, wraps in [0,1) and is frozen under reduced motion', () => {
    expect(parallaxOffset(0, SKYLINE.near.speed, false)).toBe(0);
    const o = parallaxOffset(10_000, SKYLINE.near.speed, false);
    expect(o).toBeGreaterThan(0); expect(o).toBeLessThan(1);
    expect(parallaxOffset(10_000, SKYLINE.near.speed, false)).toBeLessThan(0.2); // < 20 % of the width in 10 s
    expect(parallaxOffset(10_000, SKYLINE.near.speed, true)).toBe(0);
    expect(parallaxOffset(10_000, SKYLINE.far.speed, false)).toBeLessThan(parallaxOffset(10_000, SKYLINE.near.speed, false));
  });
});
