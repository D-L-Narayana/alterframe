import type { AdaptiveQualityPolicy, PerfSample } from '@/types/capture';
import type { QualitySettings } from '@/types/render';

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

/**
 * Quality ladder, one rung at a time: first shrink renderScale (cheapest visual cost),
 * then skip segmentation frames. `null` when already at the floor.
 */
export function stepDown(q: QualitySettings, o: AdaptivePolicyOptions = {}): QualitySettings | null {
  const { scaleStep, minScale, maxStride } = { ...DEFAULTS, ...o };
  if (q.renderScale > minScale) return { ...q, renderScale: r2(Math.max(minScale, q.renderScale - scaleStep)) };
  if (q.segmentationStride < maxStride) return { ...q, segmentationStride: q.segmentationStride + 1 };
  return null;
}

/** Inverse of `stepDown`: restore segmentation first (most visible), then renderScale. */
export function stepUp(q: QualitySettings, o: AdaptivePolicyOptions = {}): QualitySettings | null {
  const { scaleStep, maxScale } = { ...DEFAULTS, ...o };
  if (q.segmentationStride > 1) return { ...q, segmentationStride: q.segmentationStride - 1 };
  if (q.renderScale < maxScale) return { ...q, renderScale: r2(Math.min(maxScale, q.renderScale + scaleStep)) };
  return null;
}

/**
 * Stateful policy (remembers when it last changed quality, for the cooldown). Create one per
 * runtime; `defaultAdaptivePolicy` is a convenience instance for the W2 runtime import.
 *
 * Time comes from the samples themselves (`t` of the newest sample), never from a clock, so the
 * policy is deterministic and testable.
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
          const next = stepDown(current, o);
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

/** Contract export (W2 imports this name). Shared instance: one cooldown clock per page. */
export const defaultAdaptivePolicy: AdaptiveQualityPolicy = createAdaptivePolicy();
