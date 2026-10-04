import type { Vec2, Size } from './geometry';
import type { TrackingFrame } from './tracking';
import type { WindowQuad } from './interaction';
import type { SceneState, HudTint } from './scene';

/** A callout = 7-digit code label anchored to a point, optional leader line to another anchor. */
export interface HudCallout {
  id: 'corner' | 'eye-left' | 'eye-right' | 'hand-left' | 'hand-right' | 'mouth';
  anchor: Vec2;                 // normalized display space
  code: string;                 // e.g. "1610100"
  leaderTo?: Vec2;              // normalized; draws a thin line anchor→leaderTo
  bracket?: boolean;            // small corner bracket at anchor
  box?: { w: number; h: number }; // optional thin rectangle centered at anchor (normalized)
}

/** Free-standing thin rectangle (normalized), e.g. the open-mouth box. */
export interface HudBox { center: Vec2; w: number; h: number }

/** Self-timer countdown rendered inside the composited frame. */
export interface HudCountdown {
  action: 'record' | 'snapshot';
  /** Whole seconds left, ≥ 1 while the countdown runs. */
  secondsLeft: number;
  /** 0..1 elapsed fraction of the whole countdown. */
  progress: number;
}

/** Per-frame extras the runtime hands to `Hud.buildModel`. */
export interface HudExtras {
  recording: boolean;
  fps: number | null;
  showFps: boolean;
  countdown?: HudCountdown | null;
  /** 0..1 progress of the hold-still gesture (draws a ring at the corner callout); null/undefined = none. */
  dwellProgress?: number | null;
}

export interface HudModel {
  tint: HudTint;
  callouts: HudCallout[];
  /** 0..1 global opacity (follows window opacity). */
  opacity: number;
  recording: boolean;
  fps: number | null;
  boxes?: HudBox[];
  countdown?: HudCountdown | null;
  dwellProgress?: number | null;
}

export interface Hud {
  resize(size: Size): void;
  buildModel(frame: TrackingFrame | null, quad: WindowQuad | null, scene: SceneState, t: number, extras: HudExtras): HudModel;
  draw(model: HudModel): void;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
}
