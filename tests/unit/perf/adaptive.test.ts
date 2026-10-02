import { describe, it, expect } from 'vitest';
import { createAdaptivePolicy, defaultAdaptivePolicy, stepDown, stepUp, median } from '@/perf/adaptive';
import type { PerfSample } from '@/types/capture';
import type { QualitySettings } from '@/types/render';
import { DEFAULT_QUALITY } from '@/types/render';

/** Samples every `stepMs` from `from` (inclusive) to `to` (inclusive) at a constant fps. */
function run(from: number, to: number, fps: number | ((t: number) => number), stepMs = 50): PerfSample[] {
  const out: PerfSample[] = [];
  for (let t = from; t <= to; t += stepMs) {
    const f = typeof fps === 'function' ? fps(t) : fps;
    out.push({ t, fps: f, frameMs: 1000 / Math.max(f, 1), trackingMs: 5, renderMs: 3 });
  }
  return out;
}

const q = (p: Partial<QualitySettings> = {}): QualitySettings => ({ ...DEFAULT_QUALITY, ...p });

describe('median', () => {
  it('handles odd/even lengths and empty input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('stepDown / stepUp ladder', () => {
  it('reduces renderScale by 0.15 down to 0.5 before touching segmentation stride', () => {
    expect(stepDown(q())).toEqual(q({ renderScale: 0.85 }));
    expect(stepDown(q({ renderScale: 0.55 }))).toEqual(q({ renderScale: 0.5 }));
    expect(stepDown(q({ renderScale: 0.5 }))).toEqual(q({ renderScale: 0.5, segmentationStride: 2 }));
    expect(stepDown(q({ renderScale: 0.5, segmentationStride: 2 }))).toEqual(q({ renderScale: 0.5, segmentationStride: 3 }));
    expect(stepDown(q({ renderScale: 0.5, segmentationStride: 3 }))).toBeNull();
  });
  it('restores stride first, then renderScale up to 1', () => {
    expect(stepUp(q({ renderScale: 0.5, segmentationStride: 3 }))).toEqual(q({ renderScale: 0.5, segmentationStride: 2 }));
    expect(stepUp(q({ renderScale: 0.5, segmentationStride: 1 }))).toEqual(q({ renderScale: 0.65 }));
    expect(stepUp(q({ renderScale: 0.95 }))).toEqual(q({ renderScale: 1 }));
    expect(stepUp(q())).toBeNull();
  });
  it('never alters maxDpr', () => {
    expect(stepDown(q({ maxDpr: 3 }))!.maxDpr).toBe(3);
    expect(stepUp(q({ renderScale: 0.5, maxDpr: 1 }))!.maxDpr).toBe(1);
  });
});

describe('createAdaptivePolicy — step down', () => {
  it('returns null until 2 s of history exist', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 1000, 10), q())).toBeNull();
    expect(p.evaluate(run(0, 1900, 10), q())).toBeNull();
  });

  it('steps renderScale down when the 2 s median fps is below 22', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 2000, 18), q())).toEqual(q({ renderScale: 0.85 }));
  });

  it('does not step down at exactly 22 fps or between 22 and 40', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 3000, 22), q())).toBeNull();
    expect(p.evaluate(run(0, 3000, 30), q())).toBeNull();
  });

  it('uses the median: a few hitches inside a fast 2 s window do not trigger', () => {
    const p = createAdaptivePolicy();
    const samples = run(0, 2000, (t) => (t % 500 === 0 ? 5 : 60));
    expect(p.evaluate(samples, q())).toBeNull();
  });

  it('ignores warm-up samples with fps 0', () => {
    const p = createAdaptivePolicy();
    const samples = [...run(0, 2000, 0), ...run(2050, 4000, 60)];
    expect(p.evaluate(samples, q())).toBeNull();
  });

  it('only looks at the last 2 s, not older slow history', () => {
    const p = createAdaptivePolicy();
    const samples = [...run(0, 3000, 10), ...run(3050, 5100, 50)];
    expect(p.evaluate(samples, q())).toBeNull();
  });

  it('enforces a 3 s cooldown between changes, then continues down the ladder', () => {
    const p = createAdaptivePolicy();
    let cur = q();
    cur = p.evaluate(run(0, 2000, 10), cur)!;
    expect(cur.renderScale).toBe(0.85);
    expect(p.evaluate(run(0, 2500, 10), cur)).toBeNull();
    expect(p.evaluate(run(0, 4900, 10), cur)).toBeNull();
    const next = p.evaluate(run(0, 5000, 10), cur);
    expect(next).toEqual(q({ renderScale: 0.7 }));
  });

  it('walks the whole ladder and returns null at the floor', () => {
    const p = createAdaptivePolicy();
    let cur = q();
    const seen: Array<[number, number]> = [];
    for (let t = 2000; t <= 40_000; t += 3000) {
      const r = p.evaluate(run(0, t, 10), cur);
      if (r) {
        cur = r;
        seen.push([r.renderScale, r.segmentationStride]);
      }
    }
    expect(seen).toEqual([
      [0.85, 1],
      [0.7, 1],
      [0.55, 1],
      [0.5, 1],
      [0.5, 2],
      [0.5, 3],
    ]);
    expect(p.evaluate(run(0, 60_000, 10), cur)).toBeNull();
  });
});

describe('createAdaptivePolicy — step up', () => {
  it('steps up after fps > 40 for 5 s, restoring stride before scale', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 5000, 55), q({ renderScale: 0.5, segmentationStride: 3 }))).toEqual(
      q({ renderScale: 0.5, segmentationStride: 2 }),
    );
  });

  it('needs the full 5 s: 4 s of fast frames is not enough', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 4000, 55), q({ renderScale: 0.5 }))).toBeNull();
  });

  it('a single slow sample inside the 5 s window blocks the step up', () => {
    const p = createAdaptivePolicy();
    const samples = run(0, 5000, (t) => (t === 2500 ? 35 : 55));
    expect(p.evaluate(samples, q({ renderScale: 0.5 }))).toBeNull();
  });

  it('counts the 5 s from the last change, not from stale history', () => {
    const p = createAdaptivePolicy();
    let cur = q();
    cur = p.evaluate(run(0, 2000, 10), cur)!; // change at t = 2000
    // Fast ever since, but only 4 s after the change → still null; at 5 s → up.
    expect(p.evaluate([...run(0, 2000, 10), ...run(2050, 6000, 60)], cur)).toBeNull();
    expect(p.evaluate([...run(0, 2000, 10), ...run(2050, 7000, 60)], cur)).toEqual(q());
  });

  it('returns null at full quality even when fast', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 10_000, 60), q())).toBeNull();
  });

  it('respects the user lowering quality externally (works from `current`, not internal state)', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 6000, 60), q({ renderScale: 0.8 }))).toEqual(q({ renderScale: 0.95 }));
  });
});

describe('defaultAdaptivePolicy', () => {
  it('is a ready-to-use policy with the contract thresholds', () => {
    expect(typeof defaultAdaptivePolicy.evaluate).toBe('function');
    const p = createAdaptivePolicy(); // fresh instance to avoid cross-test cooldown state
    expect(p.evaluate(run(0, 2000, 21.9), q())).toEqual(q({ renderScale: 0.85 }));
  });
});
