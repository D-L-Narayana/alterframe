import { describe, expect, it } from 'vitest';
import { createCornerSpring, springStep } from '../../../src/interaction/spring';
import type { QuadCorners } from '../../../src/types';

const square = (o = 0): QuadCorners => [
  { x: 0.2 + o, y: 0.2 }, { x: 0.8 + o, y: 0.2 }, { x: 0.8 + o, y: 0.8 }, { x: 0.2 + o, y: 0.8 },
];

describe('springStep (critically damped, 1-D)', () => {
  it('moves towards the target without overshoot and converges', () => {
    let s = { x: 0, v: 0 };
    let prev = 0;
    for (let i = 0; i < 120; i++) {
      s = springStep(s, 1, 0.35, 16.67);
      expect(s.x).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(s.x).toBeLessThanOrEqual(1 + 1e-9);
      prev = s.x;
    }
    expect(s.x).toBeCloseTo(1, 3);
  });
  it('zero dt is a no-op; non-finite dt snaps to target', () => {
    expect(springStep({ x: 0.3, v: 0.1 }, 1, 0.35, 0)).toEqual({ x: 0.3, v: 0.1 });
    expect(springStep({ x: 0.3, v: 0.1 }, 1, 0.35, Number.NaN)).toEqual({ x: 1, v: 0 });
  });
  it('a huge dt (tab was hidden) lands on the target instead of exploding', () => {
    const s = springStep({ x: 0, v: 0 }, 1, 0.35, 60_000);
    expect(s.x).toBeCloseTo(1, 6);
    expect(Math.abs(s.v)).toBeLessThan(1e-6);
  });
});

describe('createCornerSpring', () => {
  it('first sample snaps to the target', () => {
    const sp = createCornerSpring(0.35);
    expect(sp.update(square(), 0)).toEqual(square());
  });
  it('subsequent samples lag behind a jump then converge', () => {
    const sp = createCornerSpring(0.35);
    sp.update(square(), 0);
    const q = sp.update(square(0.3), 16);
    expect(q[0].x).toBeGreaterThan(0.2);
    expect(q[0].x).toBeLessThan(0.5);
    let last = q;
    for (let t = 32; t < 2000; t += 16) last = sp.update(square(0.3), t);
    expect(last[0].x).toBeCloseTo(0.5, 4);
  });
  it('reset() makes the next sample snap again', () => {
    const sp = createCornerSpring(0.35);
    sp.update(square(), 0);
    sp.reset();
    expect(sp.update(square(0.3), 16)).toEqual(square(0.3));
  });
  it('stiffness outside (0,1] is clamped and still converges', () => {
    const sp = createCornerSpring(5);
    sp.update(square(), 0);
    let last = sp.update(square(0.3), 16);
    for (let t = 32; t < 1000; t += 16) last = sp.update(square(0.3), t);
    expect(last[2].x).toBeCloseTo(1.1, 4);
  });
});
