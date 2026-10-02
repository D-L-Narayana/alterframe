import type { QuadCorners, Vec2 } from './geometry';
import type { TrackingFrame } from './tracking';
import type { PersonaId, SceneState } from './scene';

export type WindowOrdering = 'convex' | 'faithful';

export interface WindowQuad {
  /** TL, TR, BR, BL in normalized display space. */
  corners: QuadCorners;
  /** 0..1 fade (hold/fade-out when a hand is lost). */
  opacity: number;
  /** Normalized height ≈ mean of left-edge and right-edge lengths (used for the "thin strip glitch"). */
  thickness: number;
  /** Signed-area magnitude in normalized units. */
  area: number;
  centroid: Vec2;
  visible: boolean;
  ordering: WindowOrdering;
}

export type InteractionEvent =
  | { type: 'window-open' }
  | { type: 'window-close' }
  | { type: 'cycle-persona'; next: PersonaId }
  | { type: 'hands-together-armed' };

export interface InteractionSettings {
  ordering: WindowOrdering;
  /** Hold the last quad this long after a hand is lost before fading (ms). Default 300. */
  holdMs: number;
  /** Fade-out duration after hold (ms). Default 150. */
  fadeMs: number;
  /** Min detection score to use a hand. Default 0.5. */
  minHandScore: number;
  /** Hands-together gesture: palm distance threshold (normalized by frame width). Default 0.12. */
  togetherDistance: number;
  /** Hands-together must persist this long to arm the persona cycle (ms). Default 500. */
  togetherArmMs: number;
  /** Window area threshold to count as "open" after being armed. Default 0.02. */
  openArea: number;
  /** Enable persona cycling via the hands-together gesture. */
  gestureCycleEnabled: boolean;
}

export const DEFAULT_INTERACTION_SETTINGS: InteractionSettings = {
  ordering: 'convex', holdMs: 300, fadeMs: 150, minHandScore: 0.5,
  togetherDistance: 0.12, togetherArmMs: 500, openArea: 0.02, gestureCycleEnabled: true,
};

export interface InteractionOutput {
  quad: WindowQuad | null;
  events: InteractionEvent[];
  /** Debug values for the dev overlay. */
  debug: { armed: boolean; togetherMs: number; handsUsed: number };
}

export interface Interaction {
  update(frame: TrackingFrame | null, t: number, scene: SceneState, settings: InteractionSettings): InteractionOutput;
  reset(): void;
}

export interface Director {
  start(t: number): void;
  stop(): void;
  /** Returns the scene for time t, or null when not running. */
  update(t: number): SceneState | null;
  readonly running: boolean;
}
