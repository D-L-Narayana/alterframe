/**
 * Style presets: ordered pass chains for the two looks the app needs.
 *
 *  paper-portrait  smooth → quantize(clean) → ink(all edges, paper background) → grade(paper)
 *  comic           smooth → quantize(warm)  → ink → halftone → backdrop → grade(comic)
 *
 * Both presets set `usesBackdrop: true`: paper-portrait paints `u_backdrop` (the persona
 * layer's paper) where the mask says background, comic paints the persona layer's night
 * city / warm paper there.
 *
 * `COMIC_BASE_PRESET` is the comic chain WITHOUT the backdrop pass, for the full-frame base
 * layer (`scene.base === 'comic'`), where the real room must stay visible as stylized
 * comic — replacing it with the persona backdrop would be wrong there. `presetForLayer`
 * encodes the scene → preset mapping (window: by persona; base: live → raw video,
 * comic → the base chain).
 *
 * Look tuning (`LookSettings`) does not change the chains: every pass reads `ctx.look` in
 * its `uniforms()`; the pass lists and their order are fixed.
 */
import type { StylePreset, StyleId } from '../types/render';
import type { SceneState } from '../types/scene';
import {
  smoothH, smoothV, quantizeClean, quantizeWarm, inkPaper, inkComic, halftone, backdrop, gradePaper, gradeComic,
} from './shaders';

export const STYLE_PRESETS: Record<StyleId, StylePreset> = {
  'paper-portrait': {
    id: 'paper-portrait',
    usesBackdrop: true,
    passes: [smoothH, smoothV, quantizeClean, inkPaper, gradePaper],
  },
  comic: {
    id: 'comic',
    usesBackdrop: true,
    passes: [smoothH, smoothV, quantizeWarm, inkComic, halftone, backdrop, gradeComic],
  },
};

/** Full-frame comic stylization for the base layer: same look, background kept. */
export const COMIC_BASE_PRESET: StylePreset = {
  id: 'comic',
  usesBackdrop: false,
  passes: STYLE_PRESETS.comic.passes.filter((p) => p !== backdrop),
};

/**
 * Every preset the renderer can run, for `Renderer.warm()` at start-up (compile all programs
 * before the first styled frame). Order: the two window looks, then the base-layer chain.
 */
export const ALL_PRESETS: readonly StylePreset[] = Object.freeze([STYLE_PRESETS['paper-portrait'], STYLE_PRESETS.comic, COMIC_BASE_PRESET]);

/**
 * Which preset a layer should run for a scene.
 *  - window: portrait → paper-portrait, masked / suit → comic (+backdrop)
 *  - base:   live → null (raw video), comic → COMIC_BASE_PRESET
 */
export function presetForLayer(scene: SceneState, layer: 'base' | 'window'): StylePreset | null {
  if (layer === 'window') return scene.persona === 'portrait' ? STYLE_PRESETS['paper-portrait'] : STYLE_PRESETS.comic;
  return scene.base === 'comic' ? COMIC_BASE_PRESET : null;
}
