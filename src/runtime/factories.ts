/**
 * Factory resolution — static imports of the real modules, except tracking.
 *
 * The real modules are imported statically so type drift is caught by `tsc` and the bundle has no
 * stub code path; `stubbed` is always empty (kept in the return shape so the handle/tests remain
 * unchanged) and `./stubs` is test-only (`tests/unit/media/runtimeHarness.ts`). Tracking is the one
 * exception: `createLazyTracker` imports `@/tracking` (MediaPipe) dynamically on `init()`, so the
 * entry chunk stays free of `@mediapipe/tasks-vision` and the shell paints before the models load.
 */
import type { AdaptiveQualityPolicy, CreateTracker, Director, DirectorStep, Hud, Interaction, PersonaLayer, Recorder, Renderer, SceneState, StyleId, StylePreset } from '@/types';
import { createRenderer } from '@/render/core';
import { ALL_PRESETS, STYLE_PRESETS, presetForLayer as realPresetForLayer } from '@/render/styles';
import { createPersonaLayer } from '@/render/persona';
import { createInteraction, createDirector, drawLandmarks } from '@/interaction';
import { createHud, type DebugDrawFn } from '@/hud';
import { createRecorder } from '@/capture';
import { createPerfMonitor, createAdaptivePolicy, type PerfMonitor } from '@/perf';
import { createLazyTracker } from './lazyTracker';

/** Options the runtime passes to the HUD factory (`createHud`); the stub ignores them. */
export interface HudFactoryOptions {
  reducedMotion?: boolean;
  debugLandmarks?: boolean;
  /** Interaction module's `drawLandmarks` (the HUD falls back to its own drawer when omitted). */
  debugDraw?: DebugDrawFn;
}

/** Scene → preset per layer (`presetForLayer`): base comic must keep the real room (no backdrop pass). */
export type PresetForLayer = (scene: SceneState, layer: 'base' | 'window') => StylePreset | null;

export interface RuntimeFactories {
  createTracker: CreateTracker;
  createRenderer: () => Renderer;
  stylePresets: Record<StyleId, StylePreset>;
  presetForLayer: PresetForLayer;
  /** Every preset the renderer may run; handed to `Renderer.warm` once after init (idle time). */
  warmPresets: readonly StylePreset[];
  createPersonaLayer: () => PersonaLayer;
  createInteraction: () => Interaction;
  createDirector: (sequence?: readonly DirectorStep[]) => Director;
  createHud: (opts?: HudFactoryOptions) => Hud;
  /** Landmark drawer passed into the HUD for the dev overlay. */
  debugDraw: DebugDrawFn | null;
  createRecorder: (getCanvas: () => HTMLCanvasElement) => Recorder;
  createPerfMonitor: () => PerfMonitor;
  /** Per-runtime policy instance (`createAdaptivePolicy()` rather than the shared default, to avoid cross-session cooldown state). */
  adaptivePolicy: AdaptiveQualityPolicy;
}

export type FactoryName = keyof RuntimeFactories;

export interface ResolvedFactories {
  factories: RuntimeFactories;
  /** Names that fell back to stubs (empty at full integration). */
  stubbed: FactoryName[];
}

/** Presets to pre-compile after init (`Renderer.warm`): the styles module's `ALL_PRESETS` (paper-portrait, comic, comic base). */
export const WARM_PRESETS: readonly StylePreset[] = ALL_PRESETS;

/** Resolves the real factories, applying `overrides` first (tests/harness). Never falls back to stubs. */
export function resolveFactories(overrides: Partial<RuntimeFactories> = {}): ResolvedFactories {
  const real: RuntimeFactories = {
    createTracker: (opts, onProgress) => createLazyTracker(opts, onProgress),
    createRenderer: () => createRenderer(),
    stylePresets: STYLE_PRESETS,
    presetForLayer: realPresetForLayer,
    warmPresets: WARM_PRESETS,
    createPersonaLayer: () => createPersonaLayer(),
    createInteraction: () => createInteraction(),
    createDirector: (sequence) => (sequence ? createDirector(sequence) : createDirector()),
    createHud: (opts) => createHud(opts ?? {}),
    debugDraw: drawLandmarks,
    createRecorder: (getCanvas) => createRecorder(getCanvas),
    createPerfMonitor: () => createPerfMonitor(),
    adaptivePolicy: createAdaptivePolicy(),
  };
  return { factories: { ...real, ...overrides }, stubbed: [] };
}
