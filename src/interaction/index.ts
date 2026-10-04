/**
 * W7 — Window geometry, gestures, Director. Public entry point (`@/interaction`).
 *
 * `createInteraction()` wraps the pure geometry (windowQuad.ts) with:
 *   • hold/fade: after both hands are no longer tracked the last quad is held for `holdMs`,
 *     then fades linearly to 0 over `fadeMs` (opacity is the only thing that changes);
 *   • `window-open` / `window-close` events on the visibility edge (opacity > 0);
 *   • the optional hands-together persona-cycle gesture (gesture.ts);
 *   • the cosmetic corner spring (spring.ts), driven by `settings.cornerSpring` (0 = off, the default);
 *   • the hold-still detector (dwell.ts), driven by `settings.dwellMs` (0 = off, the default).
 *
 * The window is NOT gated on area or on any gesture: whenever two hands pass `minHandScore`
 * a quad is produced, even a zero-area slit.
 */
import type { Interaction, InteractionOutput, InteractionSettings, QuadCorners, TrackingFrame, SceneState, WindowQuad } from '../types';
import { computeWindowQuad, selectHands } from './windowQuad';
import { createGestureDetector } from './gesture';
import { createCornerSpring, DEFAULT_SPRING_STIFFNESS } from './spring';
import type { CornerSpring } from './spring';
import { createDwellDetector } from './dwell';

export { computeWindowQuad, selectHands, segmentsIntersect, isSelfIntersecting, shoelaceArea, orderConvex, orderFaithful } from './windowQuad';
export { createDirector, stepIndexAt, sceneForStep } from './director';
export type { DirectorWithSteps } from './director';
export { drawLandmarks, HAND_CONNECTIONS } from './debugDraw';
export type { DebugCanvas2D, DebugDrawExtras } from './debugDraw';
export { createGestureDetector, nextPersona, CYCLE_DEBOUNCE_MS, DISARM_AFTER_LOST_MS } from './gesture';
export { createCornerSpring, springStep, stiffnessToOmega, DEFAULT_SPRING_STIFFNESS } from './spring';
export type { CornerSpring } from './spring';
export { createDwellDetector } from './dwell';
export type { DwellDetector } from './dwell';

export interface InteractionOptions {
  /**
   * Fallback corner lag used while `settings.cornerSpring` is 0 (dev-harness compatibility); the
   * setting always wins when it is > 0. `stiffness` ≈ fraction of the gap closed per 60 Hz frame.
   */
  cornerSpring?: { stiffness?: number } | undefined;
}

export function createInteraction(options: InteractionOptions = {}): Interaction {
  const gesture = createGestureDetector();
  const dwell = createDwellDetector();
  const fallbackStiffness = options.cornerSpring ? (options.cornerSpring.stiffness ?? DEFAULT_SPRING_STIFFNESS) : 0;
  /** Corner spring in use (null = off) and the stiffness it is currently tuned to. */
  let spring: CornerSpring | null = null;
  let springStiffness = 0;

  /** Last quad computed from live hands (used for hysteresis and as the held quad). */
  let lastRaw: WindowQuad | null = null;
  /** Time the last live quad was seen. */
  let lastSeenT = 0;
  /** Edge state for window-open / window-close. */
  let visible = false;

  const reset = (): void => {
    lastRaw = null;
    lastSeenT = 0;
    visible = false;
    gesture.reset();
    dwell.reset();
    spring?.reset();
  };

  return {
    reset,
    update(frame: TrackingFrame | null, t: number, scene: SceneState, settings: InteractionSettings): InteractionOutput {
      const hands = frame?.hands ?? [];
      const pair = selectHands(hands, settings);
      const raw = pair ? computeWindowQuad(pair, settings, lastRaw, t) : null;
      const tOk = Number.isFinite(t);

      // Corner spring: the setting wins when > 0, otherwise the factory fallback; 0 drops it so
      // the corners equal the fingertips exactly. A changed stiffness is retuned in place.
      const stiffness = settings.cornerSpring > 0 ? settings.cornerSpring : fallbackStiffness;
      if (stiffness > 0) {
        if (!spring) spring = createCornerSpring(stiffness);
        else if (stiffness !== springStiffness) spring.setStiffness(stiffness);
        springStiffness = stiffness;
      } else if (spring) {
        spring = null;
        springStiffness = 0;
      }

      let quad: WindowQuad | null = null;
      /** This frame's live corners — the fingertips before the cosmetic spring — or null without a live pair. */
      let tips: QuadCorners | null = null;
      if (raw) {
        tips = raw.corners;
        if (spring && tOk) raw.corners = spring.update(tips, t);
        lastRaw = raw;
        if (tOk) lastSeenT = t;
        quad = raw;
      } else if (lastRaw) {
        spring?.reset();
        // Clock went backwards or is invalid → treat as "no time elapsed" (keep holding).
        const elapsed = tOk && t >= lastSeenT ? t - lastSeenT : 0;
        if (!tOk) lastSeenT = 0;
        else if (t < lastSeenT) lastSeenT = t;
        const holdMs = Math.max(0, settings.holdMs || 0);
        const fadeMs = Math.max(0, settings.fadeMs || 0);
        let opacity: number;
        if (elapsed <= holdMs) opacity = 1;
        else if (fadeMs > 0 && elapsed < holdMs + fadeMs) opacity = 1 - (elapsed - holdMs) / fadeMs;
        else opacity = 0;
        if (opacity > 0) {
          quad = { ...lastRaw, corners: lastRaw.corners, opacity, visible: true };
        } else {
          lastRaw = null;
        }
      }

      // Hold-still detector: live frames only (the held/fading quad is not the hands).
      const dwellFired = dwell.update(tips, t, settings.dwellMs, settings.dwellTolerance);

      const events = gesture.update(pair, raw, t, scene.persona, settings);
      if (dwellFired) events.push({ type: 'dwell' });
      const nowVisible = quad !== null;
      if (nowVisible && !visible) events.unshift({ type: 'window-open' });
      if (!nowVisible && visible) events.unshift({ type: 'window-close' });
      visible = nowVisible;

      const g = gesture.debug;
      return {
        quad,
        events,
        debug: { armed: g.armed, togetherMs: g.togetherMs, handsUsed: countUsable(hands, settings), dwellProgress: dwell.progress },
      };
    },
  };
}

function countUsable(hands: readonly TrackingFrame['hands'][number][], settings: InteractionSettings): number {
  let n = 0;
  for (const h of hands) {
    if (h && Number.isFinite(h.score) && h.score >= settings.minHandScore && isFiniteVec(h.indexTip) && isFiniteVec(h.thumbTip)) n++;
  }
  return n;
}

function isFiniteVec(v: { x: number; y: number } | undefined): boolean {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y);
}
