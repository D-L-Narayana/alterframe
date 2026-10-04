/**
 * W7 — hold-still ("dwell") detector: the hands-free capture trigger.
 *
 * Both hands keep the window still for `dwellMs` → one `dwell` event. The window is "still" at
 * time t when no corner has moved more than `tolerance` (normalized display units) relative to
 * ANY sample taken within the last `dwellMs`. Comparing against the whole recent window — not
 * just the previous frame — makes a slow drift count as motion while sub-tolerance jitter does not.
 *
 * Episode rules
 *   • the event fires exactly once per stillness episode, on the first frame whose stillness has
 *     lasted `dwellMs`;
 *   • the detector re-arms when a corner moves beyond the tolerance, when a frame has no live quad
 *     (pair lost — including the held/fading window), on `reset()` and when `dwellMs` is 0;
 *   • `progress` = elapsed-still / dwellMs clamped to 0..1; exactly 1 from the firing frame until
 *     the episode ends; 0 while idle or disabled.
 *
 * Samples live in a fixed ring buffer (no per-frame allocation). At most one sample is retained per
 * `dwellMs / SAMPLES_PER_WINDOW`, so the buffer spans the whole window at any frame rate, and the
 * newest sample is always kept so motion across a long frame gap (hidden tab) is still noticed.
 */
import type { QuadCorners } from '../types';

const CAPACITY = 128;
const SAMPLES_PER_WINDOW = 64;
const DEFAULT_TOLERANCE = 0.012;

export interface DwellDetector {
  /**
   * Feeds one frame. `corners` are this frame's LIVE corners (opacity 1) or null for every frame
   * without a live pair. Returns true on the frame the `dwell` event fires.
   */
  update(corners: QuadCorners | null, t: number, dwellMs: number, tolerance: number): boolean;
  /** 0..1 towards the next event (see the episode rules above). */
  readonly progress: number;
  /** Forgets everything and re-arms. */
  reset(): void;
}

export function createDwellDetector(): DwellDetector {
  const times = new Float64Array(CAPACITY);
  const coords = new Float64Array(CAPACITY * 8); // x0,y0,…,x3,y3 per sample
  const cur = new Float64Array(8);
  /** Index of the oldest sample and the number of samples held. */
  let head = 0;
  let count = 0;
  let lastPushT = 0;
  /** Time of the last accepted live frame (detects a clock going backwards). */
  let lastT = Number.NEGATIVE_INFINITY;
  /** Start of the current stillness episode. */
  let stillStart = 0;
  let fired = false;
  let progress = 0;

  const idle = (): void => {
    head = 0;
    count = 0;
    fired = false;
    progress = 0;
    lastT = Number.NEGATIVE_INFINITY;
  };

  const push = (t: number): void => {
    if (count === CAPACITY) {
      head = (head + 1) % CAPACITY;
      count--;
    }
    const i = (head + count) % CAPACITY;
    times[i] = t;
    coords.set(cur, i * 8);
    count++;
    lastPushT = t;
  };

  /** Drops samples older than `tMin`, always keeping the newest one as the reference across long gaps. */
  const prune = (tMin: number): void => {
    while (count > 1 && times[head]! < tMin) {
      head = (head + 1) % CAPACITY;
      count--;
    }
  };

  /** True when a corner of the current frame lies further than `tol` from the same corner of any retained sample. */
  const moved = (tol: number): boolean => {
    const tol2 = tol * tol;
    for (let k = 0; k < count; k++) {
      const base = ((head + k) % CAPACITY) * 8;
      for (let c = 0; c < 8; c += 2) {
        const dx = coords[base + c]! - cur[c]!;
        const dy = coords[base + c + 1]! - cur[c + 1]!;
        if (dx * dx + dy * dy > tol2) return true;
      }
    }
    return false;
  };

  /** Starts a new window at t with the current frame as its only sample. */
  const restart = (t: number): void => {
    head = 0;
    count = 0;
    stillStart = t;
    push(t);
  };

  return {
    get progress() {
      return progress;
    },
    reset: idle,
    update(corners, t, dwellMs, tolerance) {
      if (!corners || !(dwellMs > 0) || !Number.isFinite(dwellMs) || !flatten(corners, cur)) {
        idle();
        return false;
      }
      if (!Number.isFinite(t)) return false; // cannot be placed in time: keep the state, never NaN
      const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_TOLERANCE;

      if (count === 0 || t < lastT) {
        // First live frame of an episode, or the clock went backwards (the older samples now lie in the future).
        restart(t);
        lastT = t;
        progress = fired ? 1 : 0;
        return false;
      }
      lastT = t;
      prune(t - dwellMs);
      if (moved(tol)) {
        restart(t);
        fired = false;
        progress = 0;
        return false;
      }
      if (t - lastPushT >= dwellMs / SAMPLES_PER_WINDOW) push(t);
      if (fired) {
        progress = 1;
        return false;
      }
      const elapsed = t - stillStart;
      if (elapsed >= dwellMs) {
        fired = true;
        progress = 1;
        return true;
      }
      progress = Math.min(1, Math.max(0, elapsed / dwellMs));
      return false;
    },
  };
}

/** Copies the corners into `out` (x0,y0,…); false when any coordinate is non-finite. */
function flatten(corners: QuadCorners, out: Float64Array): boolean {
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return false;
    out[i * 2] = c.x;
    out[i * 2 + 1] = c.y;
  }
  return true;
}
