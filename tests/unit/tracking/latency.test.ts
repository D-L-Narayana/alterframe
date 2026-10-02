import { describe, expect, it } from 'vitest';
import { DEFAULT_SMOOTHING, OneEuroFilter, type OneEuroParams } from '@/tracking/smoothing';

/**
 * Product criterion A1: window corners must follow the fingertips with ≤ 2 frames of smoothing lag.
 * Scenario: 60 fps, 1 s of rest with ±0.3 % normalized jitter, then a smoothstep sweep of 0.6 frame
 * widths in 400 ms (a brisk but ordinary hand move), then hold.
 */
function measure(p: OneEuroParams) {
  const fps = 60;
  const dt = 1000 / fps;
  const f = new OneEuroFilter(p);
  let seed = 1;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  const raw: number[] = [];
  const sm: number[] = [];
  let t = 0;
  for (let i = 0; i < 60; i++, t += dt) {
    const x = 0.2 + rnd() * 0.006;
    raw.push(x);
    sm.push(f.filter(x, t));
  }
  const diffVar = (a: number[]) => {
    const d = a.slice(1).map((v, i) => v - (a[i] ?? 0));
    const m = d.reduce((s, v) => s + v, 0) / d.length;
    return d.reduce((s, v) => s + (v - m) ** 2, 0) / d.length;
  };
  const jitterRatio = diffVar(sm) / diffVar(raw);

  const sweepRaw: number[] = [];
  const sweepSm: number[] = [];
  const sweepFrames = 24;
  for (let i = 0; i < 90; i++, t += dt) {
    const u = Math.min(1, i / sweepFrames);
    const x = 0.2 + 0.6 * (u * u * (3 - 2 * u));
    sweepRaw.push(x);
    sweepSm.push(f.filter(x, t));
  }
  const cross = (a: number[]) => a.findIndex((v) => v >= 0.5);
  const lagMidFrames = cross(sweepSm) - cross(sweepRaw);
  const settleFrames = sweepSm.findIndex((v, i) => i >= sweepFrames && Math.abs(v - 0.8) < 0.006) - sweepFrames;
  return { jitterRatio, lagMidFrames, settleFrames };
}

describe('One-Euro defaults vs product criterion A1', () => {
  it('lags ≤ 2 frames at mid-sweep and settles within 2 frames of the hand stopping', () => {
    const m = measure(DEFAULT_SMOOTHING);
    expect(m.lagMidFrames).toBeLessThanOrEqual(2);
    expect(m.settleFrames).toBeLessThanOrEqual(2);
  });
  it('still suppresses rest jitter (variance of frame-to-frame motion < 5 % of raw)', () => {
    const m = measure(DEFAULT_SMOOTHING);
    expect(m.jitterRatio).toBeLessThan(0.05);
  });
  it('bounds jitter amplification at a pessimistic ±1 % noise level (trade-off made explicit)', () => {
    // At 3× realistic noise the speed-adaptive cutoff opens more often; we accept ≤ 0.35 here.
    let seed = 7;
    const r = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const f = new OneEuroFilter(DEFAULT_SMOOTHING);
    const dt = 1000 / 30;
    const rd: number[] = [];
    const fd: number[] = [];
    let pn = 0;
    let po = 0;
    for (let i = 0; i < 300; i++) {
      const t = i * dt;
      const clean = 0.5 + 0.2 * Math.sin(t / 1000);
      const noisy = clean + (r() - 0.5) * 0.02;
      const out = f.filter(noisy, t);
      if (i > 30) {
        rd.push(noisy - pn);
        fd.push(out - po);
      }
      pn = noisy;
      po = out;
    }
    const v = (a: number[]) => {
      const m = a.reduce((s, x) => s + x, 0) / a.length;
      return a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length;
    };
    expect(v(fd) / v(rd)).toBeLessThan(0.35);
  });
  it('documents why the pre-integration value failed A1', () => {
    const m = measure({ minCutoff: 1.0, beta: 0.02, dCutoff: 1.0 });
    expect(m.lagMidFrames).toBeGreaterThan(2);
  });
});
