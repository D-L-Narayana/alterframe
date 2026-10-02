import type { TrackingFrame } from './tracking';
import type { PersonaId, SceneState } from './scene';
import type { Size } from './geometry';

/**
 * Persona layer (W6): procedural, original vector art drawn on 2D canvases that the
 * renderer composites INSIDE the hand window.
 *  - overlay: RGBA, face/body-attached shapes (mask lenses, lip/eye accents, suit pattern).
 *  - backdrop: opaque, what replaces the background (paper white for 'portrait',
 *    neon city for 'masked', warm paper for 'suit').
 */
export interface PersonaLayer {
  /** Must be called when canvas size changes (device pixels). */
  resize(size: Size): void;
  update(frame: TrackingFrame | null, scene: SceneState, t: number): void;
  readonly overlay: HTMLCanvasElement | OffscreenCanvas;
  readonly backdrop: HTMLCanvasElement | OffscreenCanvas;
  readonly personaId: PersonaId;
}

export interface PersonaStyleTokens {
  paperWhite: string; ink: string; lensWhite: string; lensPink: string; lensMagenta: string;
  suitPink: string; suitWhite: string; suitBlack: string; neonBlue: string; neonMagenta: string; nightNavy: string;
}

export const PERSONA_TOKENS: PersonaStyleTokens = {
  paperWhite: '#f6f3ec', ink: '#141216', lensWhite: '#f4f1f7', lensPink: '#ff5fb0', lensMagenta: '#d9148f',
  suitPink: '#ff4fb6', suitWhite: '#f3f0f5', suitBlack: '#151319', neonBlue: '#3b7bff', neonMagenta: '#ff3fbf', nightNavy: '#0b1230',
};
