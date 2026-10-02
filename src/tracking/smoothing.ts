import type { Vec3 } from '../types/geometry';

/** One-Euro filter parameters (Casiez, Roussel, Vogel — CHI 2012). */
export interface OneEuroParams {
  /** Minimum cutoff frequency (Hz). Lower = smoother at rest, more lag. */
  minCutoff: number;
  /** Speed coefficient: how much the cutoff opens with velocity. Higher = less lag on fast moves. */
  beta: number;
  /** Cutoff (Hz) for the derivative low-pass used to estimate speed. */
  dCutoff: number;
}

/**
 * Defaults tuned at integration for product criterion A1 (≤ 2 frames of smoothing lag at 60 fps).
 * Coordinates are normalized [0,1], so speeds are in frame-widths per second and `beta` must be
 * O(1): with `beta 0.02` (the pre-integration value) a 0.6-frame-width sweep lagged 7 frames;
 * `beta 1.5` lags 2 frames and settles within 2 frames, while rest jitter variance stays < 5 % of the raw
 * input at realistic (±0.3 %) noise and < 30 % at the pessimistic ±1 % noise of smoothing.test.ts.
 * Measured by `tests/unit/tracking/latency.test.ts`.
 */
export const DEFAULT_SMOOTHING: OneEuroParams = { minCutoff: 1.0, beta: 1.5, dCutoff: 1.0 };

/** Exponential smoothing factor for a cutoff frequency `fc` (Hz) and timestep `dt` (seconds). */
function alpha(fc: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * fc);
  return 1 / (1 + tau / dt);
}

/**
 * Scalar One-Euro filter. Timestamps are in milliseconds.
 *
 * Idea: a first-order low-pass whose cutoff frequency grows with the estimated speed
 * (`fc = minCutoff + beta * |dx|`), so slow hover is heavily smoothed (no jitter) while fast
 * gestures pass almost unfiltered (little lag).
 */
export class OneEuroFilter {
  private params: OneEuroParams;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(params: OneEuroParams = DEFAULT_SMOOTHING) {
    this.params = { ...params };
  }

  setParams(params: OneEuroParams): void {
    this.params = { ...params };
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    let dt = (tMs - this.tPrev) / 1000;
    // Duplicate or out-of-order timestamps: fall back to a nominal 30 fps step instead of a
    // division by zero; the result stays finite and the filter keeps tracking.
    if (!(dt > 0)) dt = 1 / 30;
    this.tPrev = tMs;

    const { minCutoff, beta, dCutoff } = this.params;
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const fc = minCutoff + beta * Math.abs(dxHat);
    const a = alpha(fc, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

/**
 * Smooths a fixed-length set of 3-D landmarks (one One-Euro filter per coordinate).
 * The whole set resets when it has not been fed for more than `resetAfterMs` (hand lost),
 * so a hand re-entering the frame snaps to its new position instead of sliding from the old one.
 */
export class LandmarkSetSmoother {
  private filters: OneEuroFilter[] = [];
  private params: OneEuroParams;
  private lastT: number | null = null;
  private out: Vec3[] = [];

  constructor(params: OneEuroParams = DEFAULT_SMOOTHING, private readonly resetAfterMs = 500) {
    this.params = { ...params };
  }

  setParams(params: OneEuroParams): void {
    this.params = { ...params };
    for (const f of this.filters) f.setParams(this.params);
  }

  reset(): void {
    for (const f of this.filters) f.reset();
    this.lastT = null;
  }

  /** True when the smoother has state from a recent sample. */
  get active(): boolean {
    return this.lastT !== null;
  }

  /**
   * Returns a smoothed copy of `landmarks` (the output array is reused between calls, so copy
   * if you need to keep it).
   */
  apply(landmarks: readonly Vec3[], tMs: number): Vec3[] {
    if (this.lastT !== null && tMs - this.lastT > this.resetAfterMs) this.reset();
    this.lastT = tMs;

    const n = landmarks.length * 3;
    while (this.filters.length < n) this.filters.push(new OneEuroFilter(this.params));
    if (this.out.length !== landmarks.length) {
      this.out = landmarks.map(() => ({ x: 0, y: 0, z: 0 }));
    }
    for (let i = 0; i < landmarks.length; i++) {
      const p = landmarks[i]!;
      const o = this.out[i]!;
      o.x = this.filters[i * 3]!.filter(p.x, tMs);
      o.y = this.filters[i * 3 + 1]!.filter(p.y, tMs);
      o.z = this.filters[i * 3 + 2]!.filter(p.z, tMs);
    }
    return this.out;
  }
}
