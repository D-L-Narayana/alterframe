/**
 * W7 — optional critically-damped spring on the four quad corners.
 *
 * The reel's corners trail the fingertips by a frame or two. W3 already One-Euro-smooths the
 * landmarks, so this is purely cosmetic and OFF by default (see createInteraction options).
 *
 * Model: critically damped second-order system x'' = -2ω x' - ω² (x - target), integrated with
 * the closed-form solution so any dt is stable (no explosion after a hidden tab).
 * `stiffness` is expressed as the fraction of the remaining distance covered in one 60 Hz
 * frame when starting from rest (0.35 ≈ the "slight lag" called out in the contract); it is
 * converted to ω so behaviour is frame-rate independent.
 */
import type { QuadCorners, Vec2 } from '../types';

export interface SpringState1D { x: number; v: number }

const FRAME_MS = 1000 / 60;

/** Converts "fraction covered per 60 Hz frame from rest" into the angular frequency ω (1/ms). */
export function stiffnessToOmega(stiffness: number): number {
  const s = Number.isFinite(stiffness) ? Math.min(Math.max(stiffness, 1e-3), 0.999) : 0.35;
  // From rest, critically damped: x(T) = 1 - (1 + ωT) e^{-ωT} = s. Solve for ωT by bisection
  // (monotonic in ωT), then divide by the frame length.
  let lo = 0;
  let hi = 50;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const f = 1 - (1 + mid) * Math.exp(-mid);
    if (f < s) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) / FRAME_MS;
}

/** One closed-form step of a critically damped spring toward `target` over `dtMs`. */
export function springStep(state: SpringState1D, target: number, stiffness: number, dtMs: number): SpringState1D {
  if (!Number.isFinite(dtMs) || !Number.isFinite(state.x) || !Number.isFinite(state.v)) return { x: target, v: 0 };
  if (dtMs <= 0) return { x: state.x, v: state.v };
  const w = stiffnessToOmega(stiffness);
  const e = Math.exp(-w * dtMs);
  if (e < 1e-9) return { x: target, v: 0 }; // effectively converged (very large dt)
  const dx = state.x - target;
  // Critically damped closed form: x(t) = (A + B t) e^{-ωt}, A = dx, B = v + ω dx.
  const b = state.v + w * dx;
  const x = target + (dx + b * dtMs) * e;
  const v = (b - w * (dx + b * dtMs)) * e;
  return { x, v };
}

export interface CornerSpring {
  /** Returns smoothed corners for the target at time t (ms). First call snaps. */
  update(target: QuadCorners, t: number): QuadCorners;
  reset(): void;
}

export function createCornerSpring(stiffness = 0.35): CornerSpring {
  let state: SpringState1D[] | null = null; // 8 scalars: x0,y0,x1,y1,...
  let lastT = 0;
  return {
    update(target, t) {
      const flat: number[] = [];
      for (const c of target) flat.push(c.x, c.y);
      if (!state || !Number.isFinite(t)) {
        state = flat.map((x) => ({ x, v: 0 }));
        lastT = Number.isFinite(t) ? t : 0;
        return target.map(copyVec) as QuadCorners;
      }
      const dt = Math.max(0, t - lastT);
      lastT = t;
      state = state.map((s, i) => springStep(s, flat[i]!, stiffness, dt));
      const out = [] as unknown as QuadCorners;
      for (let i = 0; i < 4; i++) out[i] = { x: state[i * 2]!.x, y: state[i * 2 + 1]!.x };
      return out;
    },
    reset() {
      state = null;
    },
  };
}

function copyVec(v: Vec2): Vec2 {
  return { x: v.x, y: v.y };
}
