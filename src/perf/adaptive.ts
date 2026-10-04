import type { AdaptiveQualityPolicy, PerfSample } from '@/types/capture';
import { DEFAULT_QUALITY, type QualitySettings } from '@/types/render';

export interface AdaptivePolicyOptions {
  /** Step down when the median fps over `lowWindowMs` is below this. Default 22. */
  lowFps?: number;
  /** Step up when every sample over `highWindowMs` is above this. Default 40. */
  highFps?: number;
  lowWindowMs?: number; // default 2000
  highWindowMs?: number; // default 5000
  /** Minimum time between two changes. Default 3000. */
  cooldownMs?: number;
  scaleStep?: number; // default 0.15
  minScale?: number; // default 0.5
  maxScale?: number; // default 1
  maxStride?: number; // default 3
  /** Lowest inferenceMaxHeight rung the ladder may reach. Default 360. */
  minInferenceHeight?: number;
  /** Highest faceStride rung the ladder may reach. Default 3. */
  maxFaceStride?: number;
}

const DEFAULTS: Required<AdaptivePolicyOptions> = {
  lowFps: 22,
  highFps: 40,
  lowWindowMs: 2000,
  highWindowMs: 5000,
  cooldownMs: 3000,
  scaleStep: 0.15,
  minScale: 0.5,
  maxScale: 1,
  maxStride: 3,
  minInferenceHeight: 360,
  maxFaceStride: 3,
};

/** Median of a list; NaN for empty input. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Round to 2 decimals to keep renderScale values like 0.85 exact after repeated ±0.15 steps. */
const r2 = (v: number) => Math.round(v * 100) / 100;

/* ------------------------------------------------------------------------------------------------
 * Quality ladder v2
 *
 * Step-down order (each rung changes exactly one field; `maxDpr` is never touched):
 *   1. inferenceMaxHeight 720 → 480      (cheapest: tracking runs on a smaller frame)
 *   2. segmentationStride   1 → 2
 *   3. faceStride           1 → 2
 *   4. renderScale          1 → 0.85
 *   5. renderScale       0.85 → 0.7
 *   6. inferenceMaxHeight 480 → 360
 *   7. segmentationStride   2 → 3
 *   8. renderScale        0.7 → 0.55
 *   9. renderScale       0.55 → 0.5
 *  10. faceStride           2 → 3       (last resort: the face visibly lags)
 * `stepUp` restores in the exact reverse order (10 → 1). The cost-aware branch of `evaluate`
 * may take renderScale rungs ahead of their ladder position when the render phase dominates.
 *
 * Options reshape the ladder without reordering it: `scaleStep`/`minScale`/`maxScale` generate the
 * renderScale rungs (the first two sit at positions 4–5, the rest at 8–9), `minInferenceHeight`
 * is the value of rung 6 (rung 6 disappears when it would equal rung 1), `maxStride` and
 * `maxFaceStride` drop the stride rungs above them. Caps above the designed ladder (e.g.
 * `maxStride 4`) do not add rungs. The ceilings used when stepping up are `maxScale`,
 * `DEFAULT_QUALITY.inferenceMaxHeight` (720) and stride 1.
 * ---------------------------------------------------------------------------------------------- */

export type QualityField = 'inferenceMaxHeight' | 'segmentationStride' | 'faceStride' | 'renderScale';

/** One rung of the quality ladder: the field changed and the value it reaches when stepping down. */
export interface QualityRung {
  field: QualityField;
  value: number;
}

/** For these fields a smaller value means lower quality; for the strides it is the opposite. */
const LOWER_IS_WORSE: Record<QualityField, boolean> = {
  inferenceMaxHeight: true,
  renderScale: true,
  segmentationStride: false,
  faceStride: false,
};

const INFERENCE_CEILING = DEFAULT_QUALITY.inferenceMaxHeight;
const EPS = 1e-6;

/** True when setting `field` to `value` would lower quality relative to `current`. */
function isWorse(field: QualityField, value: number, current: number): boolean {
  return LOWER_IS_WORSE[field] ? value < current - EPS : value > current + EPS;
}

/** True when `current` already sits at `value` or beyond it on the low-quality side. */
function atOrBeyond(field: QualityField, value: number, current: number): boolean {
  return LOWER_IS_WORSE[field] ? current <= value + EPS : current >= value - EPS;
}

function withField(q: QualitySettings, field: QualityField, value: number): QualitySettings {
  const next: QualitySettings = { ...q };
  next[field] = value;
  return next;
}

/** renderScale rungs from `maxScale` down in `scaleStep`s, always ending exactly on `minScale`. */
function scaleRungs(o: Required<AdaptivePolicyOptions>): number[] {
  if (!(o.minScale < o.maxScale)) return [];
  const out: number[] = [];
  if (o.scaleStep > 0) {
    for (let k = 1; k <= 64; k++) {
      const v = r2(o.maxScale - k * o.scaleStep);
      if (v <= o.minScale + EPS) break;
      out.push(v);
    }
  }
  out.push(r2(o.minScale));
  return out;
}

/** The ladder for `options`, in step-down order (see the module comment). */
export function qualityLadder(options: AdaptivePolicyOptions = {}): QualityRung[] {
  const o = { ...DEFAULTS, ...options };
  const scales = scaleRungs(o);
  const inference = [Math.max(480, o.minInferenceHeight), o.minInferenceHeight]
    .filter((v, i, all) => all.indexOf(v) === i)
    .filter((v) => v < INFERENCE_CEILING);
  const seg = [2, 3].filter((v) => v <= o.maxStride);
  const face = [2, 3].filter((v) => v <= o.maxFaceStride);
  const ladder: QualityRung[] = [];
  const push = (field: QualityField, value: number | undefined) => {
    if (value !== undefined) ladder.push({ field, value });
  };
  push('inferenceMaxHeight', inference[0]);
  push('segmentationStride', seg[0]);
  push('faceStride', face[0]);
  for (const v of scales.slice(0, 2)) push('renderScale', v);
  push('inferenceMaxHeight', inference[1]);
  push('segmentationStride', seg[1]);
  for (const v of scales.slice(2)) push('renderScale', v);
  push('faceStride', face[1]);
  return ladder;
}

/**
 * One rung down the ladder: the first rung (in ladder order) that would still lower quality is
 * applied, so off-ladder values snap to the next rung below them. `null` at the floor.
 */
export function stepDown(q: QualitySettings, o: AdaptivePolicyOptions = {}): QualitySettings | null {
  for (const rung of qualityLadder(o)) {
    if (isWorse(rung.field, rung.value, q[rung.field])) return withField(q, rung.field, rung.value);
  }
  return null;
}

/** Only the next renderScale rung (used by the cost-aware branch). `null` when renderScale is at `minScale`. */
export function stepDownRenderScale(q: QualitySettings, o: AdaptivePolicyOptions = {}): QualitySettings | null {
  for (const rung of qualityLadder(o)) {
    if (rung.field === 'renderScale' && isWorse('renderScale', rung.value, q.renderScale)) return withField(q, 'renderScale', rung.value);
  }
  return null;
}

/**
 * Inverse of `stepDown`: the deepest rung the current settings have reached is undone, restoring
 * its field to the next better rung value (or the ceiling). `null` at full quality.
 */
export function stepUp(q: QualitySettings, o: AdaptivePolicyOptions = {}): QualitySettings | null {
  const { maxScale } = { ...DEFAULTS, ...o };
  const ladder = qualityLadder(o);
  let deepest: QualityRung | null = null;
  for (const rung of ladder) {
    if (atOrBeyond(rung.field, rung.value, q[rung.field])) deepest = rung;
  }
  if (!deepest) return null;
  const { field } = deepest;
  const current = q[field];
  const ceiling = field === 'renderScale' ? maxScale : field === 'inferenceMaxHeight' ? INFERENCE_CEILING : 1;
  const candidates = [ceiling, ...ladder.filter((r) => r.field === field).map((r) => r.value)];
  const better = LOWER_IS_WORSE[field] ? candidates.filter((v) => v > current + EPS) : candidates.filter((v) => v < current - EPS);
  if (better.length === 0) return null;
  return withField(q, field, LOWER_IS_WORSE[field] ? Math.min(...better) : Math.max(...better));
}

/**
 * Stateful policy (remembers when it last changed quality, for the cooldown). Create one per
 * runtime; `defaultAdaptivePolicy` is a shared convenience instance.
 *
 * Time comes from the samples themselves (`t` of the newest sample), never from a clock, so the
 * policy is deterministic and testable.
 *
 * Cost-aware step down: when the median `renderMs` over the low window is strictly greater than
 * the median `trackingMs`, the frame budget is dominated by rendering, so the next renderScale rung
 * is taken ahead of its ladder position; once renderScale is at the floor the ladder order resumes.
 * Stepping up is never cost-aware (exact reverse ladder order).
 */
export function createAdaptivePolicy(options: AdaptivePolicyOptions = {}): AdaptiveQualityPolicy {
  const o = { ...DEFAULTS, ...options };
  let lastChangeT = -Infinity;

  return {
    evaluate(samples: PerfSample[], current: QualitySettings): QualitySettings | null {
      // Warm-up frames carry fps 0 (monitor has not seen two frames yet): not evidence of slowness.
      const valid = samples.filter((s) => s.fps > 0);
      const newest = valid.at(-1);
      const oldest = valid[0];
      if (!newest || !oldest) return null;
      const now = newest.t;
      if (now - lastChangeT < o.cooldownMs) return null;

      // --- step down: median fps over the last `lowWindowMs` ---
      // Require the window to be fully covered by history and to lie after the last change.
      const lowStart = now - o.lowWindowMs;
      if (oldest.t <= lowStart && lastChangeT <= lowStart) {
        const window = valid.filter((s) => s.t >= lowStart && s.t > lastChangeT);
        if (median(window.map((s) => s.fps)) < o.lowFps) {
          const renderHeavy = median(window.map((s) => s.renderMs)) > median(window.map((s) => s.trackingMs));
          const next = (renderHeavy ? stepDownRenderScale(current, o) : null) ?? stepDown(current, o);
          if (next) {
            lastChangeT = now;
            return next;
          }
        }
      }

      // --- step up: every sample over the last `highWindowMs` above `highFps` ---
      const highStart = now - o.highWindowMs;
      if (oldest.t <= highStart && lastChangeT <= highStart) {
        // Samples taken at/before the change were measured under the old settings: exclude them.
        const window = valid.filter((s) => s.t >= highStart && s.t > lastChangeT);
        if (window.length > 0 && window.every((s) => s.fps > o.highFps)) {
          const next = stepUp(current, o);
          if (next) {
            lastChangeT = now;
            return next;
          }
        }
      }
      return null;
    },
  };
}

/** Shared instance (one cooldown clock per page); the runtime creates its own via `createAdaptivePolicy()`. */
export const defaultAdaptivePolicy: AdaptiveQualityPolicy = createAdaptivePolicy();
