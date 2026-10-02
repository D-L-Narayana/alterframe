/**
 * W8 — HUD callouts overlay.
 *
 * Public API:
 *   createHud(opts?) → Hud & { setOptions(), options }
 *   buildHudModel()  (pure, ./model)   drawHud() (./draw)   codePrefix() (./code)
 *
 * The HUD owns one RGBA canvas (OffscreenCanvas when available) that W4 composites
 * last. `buildModel` is pure; `draw` only touches the canvas when the model's
 * visible content changed, and flips `canvas.__dirty` so W4 can skip the upload.
 */
import type { DirtyCanvas, Hud, HudModel, SceneState, Size, TrackingFrame, WindowQuad } from '@/types';
import { buildHudModel, type BuildExtras, type HudModelExt } from './model';
import { drawHud, type DebugDrawFn, type Hud2D } from './draw';
import { drawDebugLandmarks } from './debugDraw';
import { BLINK_PERIOD_MS } from './layout';

export { buildHudModel, EYE_RIGHT_MIN_AREA, MOUTH_OPEN_BOX_THRESHOLD, MOUTH_BOX_WIDTH_FACTOR } from './model';
export type { HudModelExt, HudBox, BuildExtras } from './model';
export { drawHud, HUD_COLORS, HUD_FONT_STACK } from './draw';
export type { DebugDrawFn, DrawOptions, Hud2D } from './draw';
export { codePrefix, buildCode, CODE_SUFFIX, PREFIX_PERIOD_MS } from './code';
export { drawDebugLandmarks } from './debugDraw';
export * as hudLayout from './layout';

/** Anything with width/height and a 2D context: HTMLCanvasElement, OffscreenCanvas, or a test double. */
export interface HudCanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): Hud2D | null;
  __dirty?: boolean;
}

export interface HudOptions {
  /** Disable blink/flicker. Default: `settings.reducedMotion` is not reachable from the contract, so we fall back to `prefers-reduced-motion`. */
  reducedMotion?: boolean;
  /** Draw tracking landmarks after the HUD (dev). Default false. */
  debugLandmarks?: boolean;
  /** Landmark drawer — pass W7's `drawLandmarks`; defaults to W8's own minimal drawer. */
  debugDraw?: DebugDrawFn;
  /** Seed for the deterministic code prefix. Default 0. */
  seed?: number;
  /** Canvas factory (tests / harness). */
  createCanvas?: () => HudCanvasLike;
  /** Font family override. */
  fontFamily?: string;
  /**
   * Font loader (defaults to `document.fonts` when present). The HUD draws with the
   * fallback face until Inter is ready, then forces one redraw so no frame is stuck
   * on the system font (lead checklist B.17).
   */
  fonts?: { load(font: string): Promise<unknown> } | null;
}

/** Font request used to warm Inter 300 before the first HUD frame. */
export const HUD_FONT_WARMUP = '300 16px Inter';

export interface HudHandle extends Hud {
  setOptions(partial: Partial<Omit<HudOptions, 'createCanvas'>>): void;
  readonly options: Readonly<Required<Pick<HudOptions, 'reducedMotion' | 'debugLandmarks' | 'seed'>>>;
}

function defaultCanvas(): HudCanvasLike {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1) as unknown as HudCanvasLike;
  if (typeof document !== 'undefined') return document.createElement('canvas') as unknown as HudCanvasLike;
  // Headless environments (unit tests without a factory): inert canvas, draws are no-ops.
  return { width: 0, height: 0, getContext: () => null };
}

function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * Cheap structural signature of what will end up on the canvas. Two models with
 * the same key draw identically, so the second draw is skipped. Blink phase is
 * folded in only while recording without reduced motion.
 */
function modelKey(m: HudModelExt, size: Size, reducedMotion: boolean, debug: boolean): string {
  const parts: (string | number)[] = [size.width, size.height, m.tint, m.opacity.toFixed(3), m.recording ? 1 : 0, m.fps === null ? 'n' : Math.round(m.fps)];
  for (const c of m.callouts) {
    parts.push(c.id, c.code, c.anchor.x.toFixed(4), c.anchor.y.toFixed(4));
    if (c.leaderTo) parts.push(c.leaderTo.x.toFixed(4), c.leaderTo.y.toFixed(4));
    if (c.box) parts.push(c.box.w.toFixed(4), c.box.h.toFixed(4));
    parts.push(c.bracket ? 'b' : '-');
  }
  for (const b of m.boxes) parts.push('box', b.center.x.toFixed(4), b.center.y.toFixed(4), b.w.toFixed(4), b.h.toFixed(4));
  if (m.recording && !reducedMotion) parts.push('blink', Math.floor(((m.t % BLINK_PERIOD_MS) + BLINK_PERIOD_MS) % BLINK_PERIOD_MS / (BLINK_PERIOD_MS / 2)));
  // Debug overlay changes with every frame; never dedupe while it is on.
  if (debug && m.debugFrame) parts.push('dbg', m.debugFrame.t, Math.random());
  return parts.join('|');
}

export function createHud(opts: HudOptions = {}): HudHandle {
  const canvas: HudCanvasLike & DirtyCanvas = (opts.createCanvas ?? defaultCanvas)() as HudCanvasLike & DirtyCanvas;
  let ctx: Hud2D | null = null;
  let size: Size = { width: 0, height: 0 };
  let lastKey = '';
  const state = {
    reducedMotion: opts.reducedMotion ?? prefersReducedMotion(),
    debugLandmarks: opts.debugLandmarks ?? false,
    seed: opts.seed ?? 0,
    debugDraw: opts.debugDraw ?? drawDebugLandmarks,
    fontFamily: opts.fontFamily,
  };

  const fonts = opts.fonts === undefined
    ? (typeof document !== 'undefined' && 'fonts' in document ? document.fonts : null)
    : opts.fonts;
  if (fonts) {
    // Fire-and-forget: a rejected load (font not bundled) just keeps the fallback face.
    try {
      void fonts.load(HUD_FONT_WARMUP).then(() => { lastKey = ''; }, () => undefined);
    } catch { /* FontFaceSet unavailable or threw synchronously: keep the fallback face */ }
  }

  const getCtx = (): Hud2D | null => {
    if (!ctx) ctx = canvas.getContext('2d');
    return ctx;
  };

  return {
    canvas: canvas as unknown as HTMLCanvasElement | OffscreenCanvas,
    get options() { return { reducedMotion: state.reducedMotion, debugLandmarks: state.debugLandmarks, seed: state.seed }; },

    resize(next: Size): void {
      const w = Math.round(next.width); const h = Math.round(next.height);
      if (!(w > 0 && h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return;
      if (w === size.width && h === size.height) return;
      size = { width: w, height: h };
      canvas.width = w;
      canvas.height = h;
      ctx = null;       // some browsers reset context state on resize; re-acquire lazily
      lastKey = '';     // force redraw
    },

    buildModel(frame: TrackingFrame | null, quad: WindowQuad | null, scene: SceneState, t: number, extras: BuildExtras): HudModelExt {
      return buildHudModel(frame, quad, scene, t, extras, state.seed);
    },

    draw(model: HudModel): void {
      if (!(size.width > 0 && size.height > 0)) return;
      const ext: HudModelExt = 'boxes' in model ? (model as HudModelExt) : { ...model, t: 0, boxes: [], debugFrame: null };
      const key = modelKey(ext, size, state.reducedMotion, state.debugLandmarks);
      if (key === lastKey) { canvas.__dirty = false; return; }
      const c = getCtx();
      if (!c) return;
      drawHud(c, ext, size, {
        reducedMotion: state.reducedMotion,
        debugLandmarks: state.debugLandmarks,
        debugDraw: state.debugDraw,
        ...(state.fontFamily !== undefined ? { fontFamily: state.fontFamily } : {}),
      });
      lastKey = key;
      canvas.__dirty = true;
    },

    setOptions(partial): void {
      if (partial.reducedMotion !== undefined) state.reducedMotion = partial.reducedMotion;
      if (partial.debugLandmarks !== undefined) state.debugLandmarks = partial.debugLandmarks;
      if (partial.seed !== undefined) state.seed = partial.seed;
      if (partial.debugDraw !== undefined) state.debugDraw = partial.debugDraw;
      if (partial.fontFamily !== undefined) state.fontFamily = partial.fontFamily;
      lastKey = '';
    },
  };
}
