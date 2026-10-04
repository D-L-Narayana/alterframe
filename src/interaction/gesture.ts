/**
 * W7 — hands-together → open persona-cycle gesture (optional design interpretation: in the
 * original reel the persona changes are edit cuts, not gestures).
 *
 * State machine
 *   idle ──(palms within togetherDistance AND window area < openArea/2 for togetherArmMs)──▶ armed
 *   armed ──(quad present AND area > openArea)──▶ emit cycle-persona (unless debounced) ──▶ idle
 *   armed ──(no usable hand pair for DISARM_AFTER_LOST_MS)──▶ idle
 */
import { PERSONA_ORDER } from '../types';
import type { HandTrack, InteractionEvent, InteractionSettings, PersonaId, WindowQuad } from '../types';

/** Minimum gap between two persona cycles. */
export const CYCLE_DEBOUNCE_MS = 1500;
/** Armed state is dropped when both hands are gone for this long. */
export const DISARM_AFTER_LOST_MS = 2000;

export interface GestureDebug { armed: boolean; togetherMs: number }

export interface GestureDetector {
  /**
   * @param pair   the two usable hands (screen-left, screen-right) or null
   * @param quad   this frame's raw quad (opacity 1) or null — never the held/fading one
   */
  update(pair: readonly [HandTrack, HandTrack] | null, quad: WindowQuad | null, t: number, persona: PersonaId, settings: InteractionSettings): InteractionEvent[];
  readonly debug: GestureDebug;
  reset(): void;
}

export function nextPersona(current: PersonaId): PersonaId {
  const i = PERSONA_ORDER.indexOf(current);
  return PERSONA_ORDER[(i < 0 ? 0 : i + 1) % PERSONA_ORDER.length] ?? PERSONA_ORDER[0]!;
}

export function createGestureDetector(): GestureDetector {
  let togetherStart: number | null = null;
  let togetherMs = 0;
  let armed = false;
  let lastCycleT = Number.NEGATIVE_INFINITY;
  let lastPairT: number | null = null;

  const reset = (): void => {
    togetherStart = null;
    togetherMs = 0;
    armed = false;
    lastCycleT = Number.NEGATIVE_INFINITY;
    lastPairT = null;
  };

  return {
    get debug() {
      return { armed, togetherMs };
    },
    reset,
    update(pair, quad, t, persona, settings) {
      const events: InteractionEvent[] = [];
      if (!Number.isFinite(t)) return events;
      if (!settings.gestureCycleEnabled) {
        togetherStart = null;
        togetherMs = 0;
        armed = false;
        return events;
      }

      if (pair) {
        lastPairT = t;
      } else if (armed && lastPairT !== null && t - lastPairT > DISARM_AFTER_LOST_MS) {
        armed = false;
      }

      const openArea = Number.isFinite(settings.openArea) ? settings.openArea : 0.02;
      const together =
        !!pair &&
        Math.hypot(pair[0].palmCenter.x - pair[1].palmCenter.x, pair[0].palmCenter.y - pair[1].palmCenter.y) < settings.togetherDistance &&
        (quad === null || quad.area < openArea / 2);

      if (together) {
        // Clock going backwards (or first frame) restarts the timer rather than producing negative ms.
        if (togetherStart === null || t < togetherStart) togetherStart = t;
        togetherMs = t - togetherStart;
        if (!armed && togetherMs >= settings.togetherArmMs) {
          armed = true;
          events.push({ type: 'hands-together-armed' });
        }
      } else {
        togetherStart = null;
        togetherMs = 0;
        if (armed && quad && quad.area > openArea) {
          // Fire once, then require a fresh together gesture. A debounced attempt is dropped
          // (not deferred) so a lingering open window cannot trigger a surprise cycle later.
          if (t - lastCycleT >= CYCLE_DEBOUNCE_MS) {
            lastCycleT = t;
            events.push({ type: 'cycle-persona', next: nextPersona(persona) });
          }
          armed = false;
        }
      }
      return events;
    },
  };
}
