/**
 * W7 — Window geometry, gestures, Director. Public entry point (`@/interaction`).
 *
 * `createInteraction()` wraps the pure geometry (windowQuad.ts) with:
 *   • hold/fade: after both hands are no longer tracked the last quad is held for `holdMs`,
 *     then fades linearly to 0 over `fadeMs` (opacity is the only thing that changes);
 *   • `window-open` / `window-close` events on the visibility edge (opacity > 0);
 *   • the optional hands-together persona-cycle gesture (gesture.ts);
 *   • an optional critically damped corner spring (spring.ts), OFF by default.
 *
 * The window is NOT gated on area or on any gesture: whenever two hands pass `minHandScore`
 * a quad is produced, even a zero-area slit (reference-analysis §4b.1).
 */
import type { Interaction, InteractionOutput, InteractionSettings, TrackingFrame, SceneState, WindowQuad } from '../types';
import { computeWindowQuad, selectHands } from './windowQuad';
import { createGestureDetector } from './gesture';
import { createCornerSpring } from './spring';
import type { CornerSpring } from './spring';

export { computeWindowQuad, selectHands, segmentsIntersect, isSelfIntersecting, shoelaceArea, orderConvex, orderFaithful } from './windowQuad';
export { createDirector, stepIndexAt, sceneForStep } from './director';
export type { DirectorWithSteps } from './director';
export { drawLandmarks, HAND_CONNECTIONS } from './debugDraw';
export type { DebugCanvas2D, DebugDrawExtras } from './debugDraw';
export { createGestureDetector, nextPersona, CYCLE_DEBOUNCE_MS, DISARM_AFTER_LOST_MS } from './gesture';
export { createCornerSpring, springStep, stiffnessToOmega } from './spring';
export type { CornerSpring } from './spring';

export interface InteractionOptions {
  /** Enable the cosmetic corner lag. `stiffness` ≈ fraction of the gap closed per 60 Hz frame (0.35). */
  cornerSpring?: { stiffness?: number } | undefined;
}

export function createInteraction(options: InteractionOptions = {}): Interaction {
  const gesture = createGestureDetector();
  const spring: CornerSpring | null = options.cornerSpring ? createCornerSpring(options.cornerSpring.stiffness ?? 0.35) : null;

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
    spring?.reset();
  };

  return {
    reset,
    update(frame: TrackingFrame | null, t: number, scene: SceneState, settings: InteractionSettings): InteractionOutput {
      const hands = frame?.hands ?? [];
      const pair = selectHands(hands, settings);
      const raw = pair ? computeWindowQuad(pair, settings, lastRaw, t) : null;
      const tOk = Number.isFinite(t);

      let quad: WindowQuad | null = null;
      if (raw) {
        if (spring && tOk) raw.corners = spring.update(raw.corners, t);
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

      const events = gesture.update(pair, raw, t, scene.persona, settings);
      const nowVisible = quad !== null;
      if (nowVisible && !visible) events.unshift({ type: 'window-open' });
      if (!nowVisible && visible) events.unshift({ type: 'window-close' });
      visible = nowVisible;

      const g = gesture.debug;
      return {
        quad,
        events,
        debug: { armed: g.armed, togetherMs: g.togetherMs, handsUsed: countUsable(hands, settings) },
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
