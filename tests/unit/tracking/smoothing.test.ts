import { describe, expect, it } from 'vitest';
import { OneEuroFilter, LandmarkSetSmoother, DEFAULT_SMOOTHING } from '../../../src/tracking/smoothing';
import type { Vec3 } from '../../../src/types/geometry';

/** Deterministic pseudo-random generator (mulberry32) so jitter tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function variance(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
}

describe('OneEuroFilter', () => {
  it('returns the first sample unchanged', () => {
    const f = new OneEuroFilter(DEFAULT_SMOOTHING);
    expect(f.filter(0.42, 0)).toBe(0.42);
  });

  it('converges to a constant input', () => {
    const f = new OneEuroFilter(DEFAULT_SMOOTHING);
    let v = 0;
    for (let i = 0; i < 120; i++) v = f.filter(1, i * (1000 / 30));
    expect(v).toBeCloseTo(1, 3);
  });

  it('suppresses rest jitter (output variance < 30 % of input variance at ±1 % noise)', () => {
    // A hand held still: the only input motion is landmark noise. Jitter suppression is measured on
    // the position variance itself (frame-to-frame deltas would also count legitimate motion).
    const f = new OneEuroFilter(DEFAULT_SMOOTHING);
    const r = rng(7);
    const dt = 1000 / 30;
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const noisy = 0.5 + (r() - 0.5) * 0.02; // ±1 % of the frame, pessimistic for MediaPipe
      const y = f.filter(noisy, i * dt);
      if (i > 30) { raw.push(noisy); out.push(y); }
    }
    expect(variance(out) / variance(raw)).toBeLessThan(0.3);
  });

  it('tracks a slow drift with small lag error (RMS residual < 2 % of the frame)', () => {
    const f = new OneEuroFilter(DEFAULT_SMOOTHING);
    const r = rng(7);
    const dt = 1000 / 30;
    const res: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t = i * dt;
      const clean = 0.5 + 0.2 * Math.sin(t / 1000); // 1 rad/s hover drift
      const noisy = clean + (r() - 0.5) * 0.006;    // ±0.3 % realistic jitter
      const y = f.filter(noisy, t);
      if (i > 30) res.push(y - clean);
    }
    expect(Math.sqrt(variance(res))).toBeLessThan(0.02);
  });

  it('settles after a unit step within ~10 frames at 30 fps with the contract defaults', () => {
    // With minCutoff = 1 Hz the time constant is 1/(2π) ≈ 160 ms, i.e. ~5 frames; after 10 frames
    // the response should be past 85 %. (This documents the lag budget for W7's spring.)
    const f = new OneEuroFilter(DEFAULT_SMOOTHING);
    const dt = 1000 / 30;
    f.filter(0, 0);
    let out = 0;
    for (let i = 1; i <= 10; i++) out = f.filter(1, i * dt);
    expect(out).toBeGreaterThan(0.85);
  });

  it('a higher beta reduces lag on fast motion (speed-adaptive cutoff)', () => {
    const slow = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    const fast = new OneEuroFilter({ minCutoff: 1, beta: 0.5, dCutoff: 1 });
    const dt = 1000 / 30;
    slow.filter(0, 0); fast.filter(0, 0);
    let a = 0, b = 0;
    for (let i = 1; i <= 3; i++) { a = slow.filter(1, i * dt); b = fast.filter(1, i * dt); }
    expect(b).toBeGreaterThan(a);
  });

  it('reset() forgets history', () => {
    const f = new OneEuroFilter(DEFAULT_SMOOTHING);
    f.filter(0, 0);
    f.filter(0, 33);
    f.reset();
    expect(f.filter(0.9, 66)).toBe(0.9);
  });

  it('ignores non-positive dt without producing NaN', () => {
    const f = new OneEuroFilter(DEFAULT_SMOOTHING);
    f.filter(0.5, 100);
    const v = f.filter(0.6, 100);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe('LandmarkSetSmoother', () => {
  const pts = (n: number, v: number): Vec3[] => Array.from({ length: n }, () => ({ x: v, y: v, z: v }));

  it('smooths every landmark independently and keeps array length', () => {
    const s = new LandmarkSetSmoother(DEFAULT_SMOOTHING);
    const a = s.apply(pts(21, 0), 0);
    expect(a).toHaveLength(21);
    const b = s.apply(pts(21, 1), 33);
    expect(b[3]!.x).toBeGreaterThan(0);
    expect(b[3]!.x).toBeLessThan(1);
  });

  it('resets after the track has been absent for more than resetAfterMs (500 ms)', () => {
    const s = new LandmarkSetSmoother(DEFAULT_SMOOTHING, 500);
    s.apply(pts(21, 0), 0);
    s.apply(pts(21, 0), 33);
    // 600 ms gap → filter state dropped, next sample passes through unchanged
    const out = s.apply(pts(21, 1), 700);
    expect(out[0]!.x).toBe(1);
  });

  it('does not reset for gaps shorter than resetAfterMs', () => {
    const s = new LandmarkSetSmoother(DEFAULT_SMOOTHING, 500);
    s.apply(pts(21, 0), 0);
    const out = s.apply(pts(21, 1), 300);
    expect(out[0]!.x).toBeLessThan(1);
  });

  it('setParams applies new parameters without losing continuity', () => {
    const s = new LandmarkSetSmoother(DEFAULT_SMOOTHING);
    s.apply(pts(21, 0), 0);
    s.setParams({ minCutoff: 100, beta: 0, dCutoff: 1 });
    // Very high cutoff → nearly no smoothing
    const out = s.apply(pts(21, 1), 33);
    expect(out[0]!.x).toBeGreaterThan(0.9);
  });
});
