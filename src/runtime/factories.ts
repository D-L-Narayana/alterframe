/**
 * Factory resolution — static imports of the ten real modules.
 *
 * During the parallel build this file used `import.meta.glob` so that absent modules fell back to
 * `./stubs`. At integration the tree is frozen, so the real modules are imported statically: type
 * drift is now caught by `tsc`, the bundle contains no stub code path, and `stubbed` is always empty
 * (kept in the return shape so the handle/tests remain unchanged). `./stubs` is test-only
 * (`tests/unit/media/runtimeHarness.ts`).
 */
import type { AdaptiveQualityPolicy, CreateTracker, Director, DirectorStep, Hud, Interaction, PersonaLayer, Recorder, Renderer, SceneState, StyleId, StylePreset } from '@/types';
import { createTracker } from '@/tracking';
import { createRenderer } from '@/render/core';
import { STYLE_PRESETS, presetForLayer as realPresetForLayer } from '@/render/styles';
import { createPersonaLayer } from '@/render/persona';
import { createInteraction, createDirector, drawLandmarks } from '@/interaction';
import { createHud, type DebugDrawFn } from '@/hud';
import { createRecorder } from '@/capture';
import { createPerfMonitor, createAdaptivePolicy, type PerfMonitor } from '@/perf';

/** Options the runtime passes to W8's `createHud` (shape per docs/handoffs/W8.md; the stub ignores them). */
export interface HudFactoryOptions {
  reducedMotion?: boolean;
  debugLandmarks?: boolean;
  /** W7 `drawLandmarks` (W8 falls back to its own drawer when omitted). */
  debugDraw?: DebugDrawFn;
}

/** Scene → preset per layer (W5 `presetForLayer`): base comic must keep the real room (no backdrop pass). */
export type PresetForLayer = (scene: SceneState, layer: 'base' | 'window') => StylePreset | null;

export interface RuntimeFactories {
  createTracker: CreateTracker;
  createRenderer: () => Renderer;
  stylePresets: Record<StyleId, StylePreset>;
  presetForLayer: PresetForLayer;
  createPersonaLayer: () => PersonaLayer;
  createInteraction: () => Interaction;
  createDirector: (sequence?: readonly DirectorStep[]) => Director;
  createHud: (opts?: HudFactoryOptions) => Hud;
  /** W7 landmark drawer passed into the HUD for the dev overlay. */
  debugDraw: DebugDrawFn | null;
  createRecorder: (getCanvas: () => HTMLCanvasElement) => Recorder;
  createPerfMonitor: () => PerfMonitor;
  /** Per-runtime policy instance (W9 recommends `createAdaptivePolicy()` over the shared `defaultAdaptivePolicy` to avoid cross-session cooldown state). */
  adaptivePolicy: AdaptiveQualityPolicy;
}

export type FactoryName = keyof RuntimeFactories;

export interface ResolvedFactories {
  factories: RuntimeFactories;
  /** Names that fell back to stubs (empty at full integration). */
  stubbed: FactoryName[];
}

/** Resolves the real factories, applying `overrides` first (tests/harness). Never falls back to stubs. */
export function resolveFactories(overrides: Partial<RuntimeFactories> = {}): ResolvedFactories {
  const real: RuntimeFactories = {
    createTracker,
    createRenderer: () => createRenderer(),
    stylePresets: STYLE_PRESETS,
    presetForLayer: realPresetForLayer,
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
