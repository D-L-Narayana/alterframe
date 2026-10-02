/**
 * Scene = what the base layer shows + what the hand window reveals.
 * Mirrors the six phases observed in the reference reel (see reference-analysis.md).
 */
export type BaseStyle = 'live' | 'comic';
export type PersonaId = 'portrait' | 'masked' | 'suit';
export type HudTint = 'white' | 'red';

export interface SceneState {
  base: BaseStyle;
  persona: PersonaId;
  /** Derived: 'red' when base === 'comic' (observed), unless overridden in settings. */
  hudTint: HudTint;
}

export const PERSONA_ORDER: readonly PersonaId[] = ['portrait', 'masked', 'suit'] as const;

export const DEFAULT_SCENE: SceneState = { base: 'live', persona: 'portrait', hudTint: 'white' };

/** Timeline step for the Director (auto-sequence replicating the reel's phase order). */
export interface DirectorStep { base: BaseStyle; persona: PersonaId; durationMs: number }

/** Phase order + durations measured from the reference (rounded). */
export const REFERENCE_SEQUENCE: readonly DirectorStep[] = [
  { base: 'live',  persona: 'portrait', durationMs: 13800 },
  { base: 'live',  persona: 'masked',   durationMs: 1600 },
  { base: 'comic', persona: 'masked',   durationMs: 5000 },
  { base: 'live',  persona: 'portrait', durationMs: 1700 },
  { base: 'comic', persona: 'suit',     durationMs: 1500 },
] as const;
