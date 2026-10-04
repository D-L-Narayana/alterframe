import { describe, it, expect } from 'vitest';
import { createAdaptivePolicy, defaultAdaptivePolicy, qualityLadder, stepDown, stepDownRenderScale, stepUp, median } from '@/perf/adaptive';
import type { QualityRung } from '@/perf/adaptive';
import type { PerfSample } from '@/types/capture';
import type { QualitySettings } from '@/types/render';
import { DEFAULT_QUALITY } from '@/types/render';

/** Phase-cost profiles: which half of the frame budget dominates (drives the cost-aware branch). */
const TRACKING_HEAVY = { trackingMs: 5, renderMs: 3 };
const RENDER_HEAVY = { trackingMs: 3, renderMs: 5 };

/** Samples every `stepMs` from `from` (inclusive) to `to` (inclusive) at a constant fps. */
function run(from: number, to: number, fps: number | ((t: number) => number), stepMs = 50, cost = TRACKING_HEAVY): PerfSample[] {
  const out: PerfSample[] = [];
  for (let t = from; t <= to; t += stepMs) {
    const f = typeof fps === 'function' ? fps(t) : fps;
    out.push({ t, fps: f, frameMs: 1000 / Math.max(f, 1), trackingMs: cost.trackingMs, renderMs: cost.renderMs });
  }
  return out;
}

const q = (p: Partial<QualitySettings> = {}): QualitySettings => ({ ...DEFAULT_QUALITY, ...p });

/**
 * Ladder v2, written out in full. Every state is the complete QualitySettings after one more
 * `stepDown` from the previous entry (index 0 = default). `stepUp` must walk this list backwards.
 */
const LADDER_STATES: QualitySettings[] = [
  q(),
  q({ inferenceMaxHeight: 480 }),
  q({ inferenceMaxHeight: 480, segmentationStride: 2 }),
  q({ inferenceMaxHeight: 480, segmentationStride: 2, faceStride: 2 }),
  q({ inferenceMaxHeight: 480, segmentationStride: 2, faceStride: 2, renderScale: 0.85 }),
  q({ inferenceMaxHeight: 480, segmentationStride: 2, faceStride: 2, renderScale: 0.7 }),
  q({ inferenceMaxHeight: 360, segmentationStride: 2, faceStride: 2, renderScale: 0.7 }),
  q({ inferenceMaxHeight: 360, segmentationStride: 3, faceStride: 2, renderScale: 0.7 }),
  q({ inferenceMaxHeight: 360, segmentationStride: 3, faceStride: 2, renderScale: 0.55 }),
  q({ inferenceMaxHeight: 360, segmentationStride: 3, faceStride: 2, renderScale: 0.5 }),
  q({ inferenceMaxHeight: 360, segmentationStride: 3, faceStride: 3, renderScale: 0.5 }),
];
const FLOOR = LADDER_STATES.at(-1)!;

/** The same ladder as rungs (field + value reached), in step-down order. */
const LADDER_RUNGS: QualityRung[] = [
  { field: 'inferenceMaxHeight', value: 480 },
  { field: 'segmentationStride', value: 2 },
  { field: 'faceStride', value: 2 },
  { field: 'renderScale', value: 0.85 },
  { field: 'renderScale', value: 0.7 },
  { field: 'inferenceMaxHeight', value: 360 },
  { field: 'segmentationStride', value: 3 },
  { field: 'renderScale', value: 0.55 },
  { field: 'renderScale', value: 0.5 },
  { field: 'faceStride', value: 3 },
];

/** Drives `evaluate` once every 3 s (the cooldown) with constant-fps history and collects every change. */
function walk(policy: ReturnType<typeof createAdaptivePolicy>, fps: number, cost = TRACKING_HEAVY, start = q(), untilMs = 40_000): QualitySettings[] {
  let cur = start;
  const seen: QualitySettings[] = [];
  for (let t = 2000; t <= untilMs; t += 3000) {
    const r = policy.evaluate(run(0, t, fps, 50, cost), cur);
    if (r) {
      cur = r;
      seen.push(r);
    }
  }
  return seen;
}

describe('median', () => {
  it('handles odd/even lengths and empty input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('qualityLadder', () => {
  it('lists the v2 rungs in step-down order', () => {
    expect(qualityLadder()).toEqual(LADDER_RUNGS);
  });

  it('minInferenceHeight / maxFaceStride / maxStride / minScale remove or clamp rungs without reordering the rest', () => {
    expect(qualityLadder({ minInferenceHeight: 480 })).toEqual(LADDER_RUNGS.filter((r) => !(r.field === 'inferenceMaxHeight' && r.value === 360)));
    expect(qualityLadder({ minInferenceHeight: 400 }).filter((r) => r.field === 'inferenceMaxHeight')).toEqual([
      { field: 'inferenceMaxHeight', value: 480 },
      { field: 'inferenceMaxHeight', value: 400 },
    ]);
    expect(qualityLadder({ maxFaceStride: 2 })).toEqual(LADDER_RUNGS.filter((r) => !(r.field === 'faceStride' && r.value === 3)));
    expect(qualityLadder({ maxFaceStride: 1 }).some((r) => r.field === 'faceStride')).toBe(false);
    expect(qualityLadder({ maxStride: 2 })).toEqual(LADDER_RUNGS.filter((r) => !(r.field === 'segmentationStride' && r.value === 3)));
    expect(qualityLadder({ minScale: 0.7 }).filter((r) => r.field === 'renderScale').map((r) => r.value)).toEqual([0.85, 0.7]);
    // A coarser scale step keeps the first two scale rungs in the upper half and the rest in the lower half.
    expect(qualityLadder({ scaleStep: 0.1 }).map((r) => (r.field === 'renderScale' ? r.value : r.field))).toEqual([
      'inferenceMaxHeight',
      'segmentationStride',
      'faceStride',
      0.9,
      0.8,
      'inferenceMaxHeight',
      'segmentationStride',
      0.7,
      0.6,
      0.5,
      'faceStride',
    ]);
  });
});

describe('stepDown / stepUp ladder', () => {
  // Ladder v2 (intentional change from v1, which shrank renderScale first and then raised the
  // segmentation stride): inference height and strides come first because they are the cheapest
  // visual cost; renderScale is interleaved; faceStride 3 is the last resort.
  it('walks the full ladder down in the documented order and returns null at the floor', () => {
    for (let i = 0; i + 1 < LADDER_STATES.length; i++) {
      expect(stepDown(LADDER_STATES[i]!), `step ${i + 1}`).toEqual(LADDER_STATES[i + 1]);
    }
    expect(stepDown(FLOOR)).toBeNull();
  });

  it('restores in the exact reverse order and returns null at full quality', () => {
    for (let i = LADDER_STATES.length - 1; i > 0; i--) {
      expect(stepUp(LADDER_STATES[i]!), `restore ${i}`).toEqual(LADDER_STATES[i - 1]);
    }
    expect(stepUp(q())).toBeNull();
  });

  it('stepUp is the inverse of stepDown at every rung', () => {
    let cur: QualitySettings | null = q();
    while (cur) {
      const down: QualitySettings | null = stepDown(cur);
      if (!down) break;
      expect(stepUp(down)).toEqual(cur);
      cur = down;
    }
    expect(cur).toEqual(FLOOR);
  });

  it('snaps off-ladder values to the next rung in the direction of travel', () => {
    expect(stepDown(q({ renderScale: 0.8, inferenceMaxHeight: 360, segmentationStride: 3, faceStride: 2 }))).toEqual(
      q({ renderScale: 0.7, inferenceMaxHeight: 360, segmentationStride: 3, faceStride: 2 }),
    );
    expect(stepUp(q({ renderScale: 0.8 }))).toEqual(q({ renderScale: 0.85 }));
    expect(stepDown(q({ inferenceMaxHeight: 1080 }))).toEqual(q({ inferenceMaxHeight: 480 }));
    expect(stepUp(q({ segmentationStride: 4 }))).toEqual(q({ segmentationStride: 3 }));
  });

  it('honours minInferenceHeight and maxFaceStride as floor options', () => {
    const o = { minInferenceHeight: 480, maxFaceStride: 2 };
    const floor = q({ inferenceMaxHeight: 480, segmentationStride: 3, faceStride: 2, renderScale: 0.5 });
    expect(stepDown(floor, o)).toBeNull();
    expect(stepDown(q({ inferenceMaxHeight: 480, segmentationStride: 2, faceStride: 2, renderScale: 0.7 }), o)).toEqual(
      q({ inferenceMaxHeight: 480, segmentationStride: 3, faceStride: 2, renderScale: 0.7 }),
    );
    expect(stepUp(floor, o)).toEqual(q({ inferenceMaxHeight: 480, segmentationStride: 3, faceStride: 2, renderScale: 0.55 }));
  });

  it('honours minScale / maxScale / maxStride', () => {
    expect(stepDown(q({ inferenceMaxHeight: 480, segmentationStride: 2, faceStride: 2, renderScale: 0.7 }), { minScale: 0.7 })).toEqual(
      q({ inferenceMaxHeight: 360, segmentationStride: 2, faceStride: 2, renderScale: 0.7 }),
    );
    expect(stepUp(q({ renderScale: 0.85 }), { maxScale: 0.85 })).toBeNull();
    expect(stepDown(q({ inferenceMaxHeight: 360, segmentationStride: 2, faceStride: 2, renderScale: 0.7 }), { maxStride: 2 })).toEqual(
      q({ inferenceMaxHeight: 360, segmentationStride: 2, faceStride: 2, renderScale: 0.55 }),
    );
  });

  it('never alters maxDpr', () => {
    expect(stepDown(q({ maxDpr: 3 }))!.maxDpr).toBe(3);
    expect(stepUp(q({ renderScale: 0.5, maxDpr: 1 }))!.maxDpr).toBe(1);
    for (const s of LADDER_STATES) expect(s.maxDpr).toBe(DEFAULT_QUALITY.maxDpr);
  });
});

describe('stepDownRenderScale', () => {
  it('takes only the next renderScale rung, leaving the other fields alone', () => {
    expect(stepDownRenderScale(q())).toEqual(q({ renderScale: 0.85 }));
    expect(stepDownRenderScale(q({ renderScale: 0.85 }))).toEqual(q({ renderScale: 0.7 }));
    expect(stepDownRenderScale(q({ renderScale: 0.7 }))).toEqual(q({ renderScale: 0.55 }));
    expect(stepDownRenderScale(q({ renderScale: 0.55 }))).toEqual(q({ renderScale: 0.5 }));
    expect(stepDownRenderScale(q({ renderScale: 0.8 }))).toEqual(q({ renderScale: 0.7 }));
  });

  it('returns null at the renderScale floor', () => {
    expect(stepDownRenderScale(q({ renderScale: 0.5 }))).toBeNull();
    expect(stepDownRenderScale(q({ renderScale: 0.7 }), { minScale: 0.7 })).toBeNull();
  });
});

describe('createAdaptivePolicy — step down', () => {
  it('returns null until 2 s of history exist', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 1000, 10), q())).toBeNull();
    expect(p.evaluate(run(0, 1900, 10), q())).toBeNull();
  });

  // Intentional ladder v2 change: the first rung is inferenceMaxHeight 720 → 480 (was renderScale 0.85).
  it('steps inferenceMaxHeight down to 480 first when the 2 s median fps is below 22', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 2000, 18), q())).toEqual(q({ inferenceMaxHeight: 480 }));
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

  // Intentional ladder v2 change: rung 1 is inferenceMaxHeight 480, rung 2 is segmentationStride 2.
  it('enforces a 3 s cooldown between changes, then continues down the ladder', () => {
    const p = createAdaptivePolicy();
    let cur = q();
    cur = p.evaluate(run(0, 2000, 10), cur)!;
    expect(cur).toEqual(q({ inferenceMaxHeight: 480 }));
    expect(p.evaluate(run(0, 2500, 10), cur)).toBeNull();
    expect(p.evaluate(run(0, 4900, 10), cur)).toBeNull();
    const next = p.evaluate(run(0, 5000, 10), cur);
    expect(next).toEqual(q({ inferenceMaxHeight: 480, segmentationStride: 2 }));
  });

  // Intentional ladder v2 change: the sequence is the ten-rung ladder (was 4 scale rungs + 2 stride rungs).
  it('walks the whole ladder (tracking-heavy frames) and returns null at the floor', () => {
    const p = createAdaptivePolicy();
    const seen = walk(p, 10, TRACKING_HEAVY);
    expect(seen).toEqual(LADDER_STATES.slice(1));
    expect(p.evaluate(run(0, 60_000, 10), FLOOR)).toBeNull();
  });
});

describe('createAdaptivePolicy — cost-aware step down', () => {
  it('render-heavy frames take the next renderScale rung instead of the ladder rung', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 2000, 18, 50, RENDER_HEAVY), q())).toEqual(q({ renderScale: 0.85 }));
  });

  it('tracking-heavy frames follow the ladder order', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 2000, 18, 50, TRACKING_HEAVY), q())).toEqual(q({ inferenceMaxHeight: 480 }));
  });

  it('equal medians follow the ladder (render must be strictly heavier)', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 2000, 18, 50, { trackingMs: 4, renderMs: 4 }), q())).toEqual(q({ inferenceMaxHeight: 480 }));
  });

  it('compares medians over the low window only, not older history', () => {
    const recentTracking = [...run(0, 2950, 10, 50, RENDER_HEAVY), ...run(3000, 5000, 10, 50, TRACKING_HEAVY)];
    expect(createAdaptivePolicy().evaluate(recentTracking, q())).toEqual(q({ inferenceMaxHeight: 480 }));
    const recentRender = [...run(0, 2950, 10, 50, TRACKING_HEAVY), ...run(3000, 5000, 10, 50, RENDER_HEAVY)];
    expect(createAdaptivePolicy().evaluate(recentRender, q())).toEqual(q({ renderScale: 0.85 }));
  });

  it('uses the median of each phase, so a few extreme render frames do not flip the decision', () => {
    const p = createAdaptivePolicy();
    const samples = run(0, 2000, 10).map((s, i) => (i % 10 === 0 ? { ...s, renderMs: 500 } : s));
    expect(p.evaluate(samples, q())).toEqual(q({ inferenceMaxHeight: 480 }));
  });

  it('walks renderScale to its floor first, then the rest of the ladder in order', () => {
    const p = createAdaptivePolicy();
    const seen = walk(p, 10, RENDER_HEAVY);
    expect(seen).toEqual([
      q({ renderScale: 0.85 }),
      q({ renderScale: 0.7 }),
      q({ renderScale: 0.55 }),
      q({ renderScale: 0.5 }),
      q({ renderScale: 0.5, inferenceMaxHeight: 480 }),
      q({ renderScale: 0.5, inferenceMaxHeight: 480, segmentationStride: 2 }),
      q({ renderScale: 0.5, inferenceMaxHeight: 480, segmentationStride: 2, faceStride: 2 }),
      q({ renderScale: 0.5, inferenceMaxHeight: 360, segmentationStride: 2, faceStride: 2 }),
      q({ renderScale: 0.5, inferenceMaxHeight: 360, segmentationStride: 3, faceStride: 2 }),
      q({ renderScale: 0.5, inferenceMaxHeight: 360, segmentationStride: 3, faceStride: 3 }),
    ]);
    expect(p.evaluate(run(0, 60_000, 10, 50, RENDER_HEAVY), FLOOR)).toBeNull();
  });

  it('at the renderScale floor, render-heavy frames fall back to the ladder', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 2000, 18, 50, RENDER_HEAVY), q({ renderScale: 0.5 }))).toEqual(q({ renderScale: 0.5, inferenceMaxHeight: 480 }));
  });

  it('respects minScale as the renderScale floor of the cost-aware branch', () => {
    const p = createAdaptivePolicy({ minScale: 0.85 });
    expect(p.evaluate(run(0, 2000, 18, 50, RENDER_HEAVY), q({ renderScale: 0.85 }))).toEqual(q({ renderScale: 0.85, inferenceMaxHeight: 480 }));
  });
});

describe('createAdaptivePolicy — step up', () => {
  // Intentional ladder v2 change: from { renderScale 0.5, segmentationStride 3 } the deepest ladder rung
  // is renderScale 0.5 (rung 9), which is restored before segmentationStride 3 (rung 7).
  it('steps up after fps > 40 for 5 s, restoring the deepest ladder rung first', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 5000, 55), q({ renderScale: 0.5, segmentationStride: 3 }))).toEqual(
      q({ renderScale: 0.55, segmentationStride: 3 }),
    );
    expect(createAdaptivePolicy().evaluate(run(0, 5000, 55), q({ renderScale: 0.7, segmentationStride: 3 }))).toEqual(
      q({ renderScale: 0.7, segmentationStride: 2 }),
    );
  });

  it('walks the whole ladder back up in reverse order and returns null at full quality', () => {
    const p = createAdaptivePolicy();
    let cur = FLOOR;
    const seen: QualitySettings[] = [];
    for (let t = 5000; t <= 70_000; t += 5000) {
      const r = p.evaluate(run(0, t, 55), cur);
      if (r) {
        cur = r;
        seen.push(r);
      }
    }
    expect(seen).toEqual([...LADDER_STATES].reverse().slice(1));
    expect(p.evaluate(run(0, 100_000, 55), cur)).toBeNull();
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
    cur = p.evaluate(run(0, 2000, 10), cur)!; // change at t = 2000 (→ inferenceMaxHeight 480)
    // Fast ever since, but only 4 s after the change → still null; at 5 s → up.
    expect(p.evaluate([...run(0, 2000, 10), ...run(2050, 6000, 60)], cur)).toBeNull();
    expect(p.evaluate([...run(0, 2000, 10), ...run(2050, 7000, 60)], cur)).toEqual(q());
  });

  it('returns null at full quality even when fast', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 10_000, 60), q())).toBeNull();
  });

  // Intentional ladder v2 change: explicit rungs — an off-ladder 0.8 snaps to the next rung 0.85 (was +0.15 → 0.95).
  it('respects the user lowering quality externally (works from `current`, not internal state)', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 6000, 60), q({ renderScale: 0.8 }))).toEqual(q({ renderScale: 0.85 }));
  });

  it('step up is never cost-aware: render-heavy fast frames still restore in reverse ladder order', () => {
    const p = createAdaptivePolicy();
    expect(p.evaluate(run(0, 5000, 55, 50, RENDER_HEAVY), q({ inferenceMaxHeight: 480, renderScale: 0.85 }))).toEqual(
      q({ inferenceMaxHeight: 480, renderScale: 1 }),
    );
  });
});

describe('defaultAdaptivePolicy', () => {
  it('is a ready-to-use policy with the contract thresholds', () => {
    expect(typeof defaultAdaptivePolicy.evaluate).toBe('function');
    const p = createAdaptivePolicy(); // fresh instance to avoid cross-test cooldown state
    // Intentional ladder v2 change: first rung is inferenceMaxHeight 480.
    expect(p.evaluate(run(0, 2000, 21.9), q())).toEqual(q({ inferenceMaxHeight: 480 }));
  });
});
