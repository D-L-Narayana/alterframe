import type { Vec2, Size } from './geometry';
import type { TrackingFrame } from './tracking';
import type { WindowQuad } from './interaction';
import type { SceneState, HudTint } from './scene';

/** A callout = 7-digit code label anchored to a point, optional leader line to another anchor. */
export interface HudCallout {
  id: 'corner' | 'eye-left' | 'eye-right' | 'hand-left' | 'hand-right';
  anchor: Vec2;                 // normalized display space
  code: string;                 // e.g. "1610100"
  leaderTo?: Vec2;              // normalized; draws a thin line anchor→leaderTo
  bracket?: boolean;            // small corner bracket at anchor
  box?: { w: number; h: number }; // optional thin rectangle centered at anchor (normalized)
}

export interface HudModel {
  tint: HudTint;
  callouts: HudCallout[];
  /** 0..1 global opacity (follows window opacity). */
  opacity: number;
  recording: boolean;
  fps: number | null;
}

export interface Hud {
  resize(size: Size): void;
  buildModel(frame: TrackingFrame | null, quad: WindowQuad | null, scene: SceneState, t: number, extras: { recording: boolean; fps: number | null; showFps: boolean }): HudModel;
  draw(model: HudModel): void;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
}
