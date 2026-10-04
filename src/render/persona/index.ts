import { DEFAULT_LOOK, type LookSettings, type PersonaLayer, type PersonaId, type SceneState, type Size, type TrackingFrame } from '../../types';
import { defaultCanvasFactory, getCtx, type PersonaCanvasFactory, type PersonaCanvasLike, type Ctx2D } from './canvas';
import { overlaySignature, backdropSignature } from './signature';
import { drawOverlay } from './faceOverlay';
import { drawPaperBackdrop, drawCityBackdrop, drawWarmPaperBackdrop } from './backdrops';

export type { PersonaCanvasFactory, PersonaCanvasLike } from './canvas';
export { PERSONA_PALETTE } from './palette';
export * from './geometry';
export { overlaySignature, backdropSignature } from './signature';
export { drawPortraitOverlay, drawMaskedOverlay, drawSuitOverlay, drawOverlay, OVERLAY_MAX_ALPHA } from './faceOverlay';
export { drawPaperBackdrop, drawCityBackdrop, drawWarmPaperBackdrop, generateSkyline, parallaxOffset, cityParallaxOffset, cityLayerOffset, HEAD_PARALLAX } from './backdrops';
export type { CityLayer } from './backdrops';
export { spiderEmblem } from './suitEmblem';

export interface PersonaLayerOptions {
  /** Canvas factory (tests inject a fake; browser default = OffscreenCanvas → <canvas>). */
  createCanvas?: PersonaCanvasFactory;
  /**
   * Disable the backdrop parallax drift (clock and head). Default: `prefers-reduced-motion` media
   * query when available, else false. The runtime should mirror `settings.reducedMotion` via `setReducedMotion`.
   */
  reducedMotion?: boolean;
  /** Seed for the procedural art; fixed by default so visual baselines are stable. */
  seed?: number;
}

/** PersonaLayer plus W6 extensions (superset of the contract type; `createPersonaLayer()` with no args is valid). */
export interface PersonaLayerHandle extends PersonaLayer {
  readonly overlay: PersonaLayer['overlay'] & { __dirty?: boolean };
  readonly backdrop: PersonaLayer['backdrop'] & { __dirty?: boolean };
  setReducedMotion(v: boolean): void;
  /** Force both canvases to repaint on the next update (e.g. after a context loss). */
  invalidate(): void;
}

function detectReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * Overlay alpha multiplier from the look: `overlayStrength` clamped to [0, 1]; a missing or
 * non-finite value means "authored alphas" (1), so a stale settings object can never hide the overlay.
 */
export function overlayStrengthOf(look: LookSettings): number {
  const s = look.overlayStrength;
  if (!Number.isFinite(s)) return 1;
  return s < 0 ? 0 : s > 1 ? 1 : s;
}

/** Normalized face-box centre x used for the city head parallax; 0.5 (= no parallax) without a face. */
export function faceCentreX(frame: TrackingFrame | null): number {
  const face = frame?.face;
  return face ? face.faceBox.x + face.faceBox.w / 2 : 0.5;
}

/**
 * Two canvases, repainted only when their input signature changes:
 *  - overlay  ← face landmarks + persona + look.overlayStrength (never the clock)
 *  - backdrop ← persona + size (+ 30 Hz tick and head x for the animated city unless reduced motion)
 * `resize(size)` must be called with the VIDEO FRAME size in device pixels: overlays live in
 * intrinsic video space and the compositor (W4) applies the single cover/contain fit.
 */
export function createPersonaLayer(opts: PersonaLayerOptions = {}): PersonaLayerHandle {
  const factory = opts.createCanvas ?? defaultCanvasFactory;
  const seed = opts.seed ?? 5;
  let reducedMotion = opts.reducedMotion ?? detectReducedMotion();
  let size: Size = { width: 2, height: 2 };
  const overlay: PersonaCanvasLike = factory(size.width, size.height);
  const backdrop: PersonaCanvasLike = factory(size.width, size.height);
  let overlayCtx: Ctx2D | null = null;
  let backdropCtx: Ctx2D | null = null;
  let overlaySig = '';
  let backdropSig = '';
  let personaId: PersonaId = 'portrait';

  const ctxOf = (c: PersonaCanvasLike, which: 'overlay' | 'backdrop'): Ctx2D => {
    const cached = which === 'overlay' ? overlayCtx : backdropCtx;
    if (cached) return cached;
    const ctx = getCtx(c);
    if (which === 'overlay') overlayCtx = ctx; else backdropCtx = ctx;
    return ctx;
  };

  const invalidate = () => { overlaySig = ''; backdropSig = ''; };

  const resize = (s: Size) => {
    const w = Math.max(1, Math.round(s.width)), h = Math.max(1, Math.round(s.height));
    if (w === size.width && h === size.height) return;
    size = { width: w, height: h };
    overlay.width = w; overlay.height = h;
    backdrop.width = w; backdrop.height = h;
    // Setting width/height resets the 2D state; contexts stay valid but we drop any cached clip state.
    invalidate();
  };

  const paintBackdrop = (persona: PersonaId, t: number, faceX: number) => {
    const ctx = ctxOf(backdrop, 'backdrop');
    switch (persona) {
      case 'portrait': drawPaperBackdrop(ctx, size, seed); break;
      case 'masked': drawCityBackdrop(ctx, size, t, reducedMotion, seed, faceX); break;
      case 'suit': drawWarmPaperBackdrop(ctx, size); break;
    }
    backdrop.__dirty = true;
  };

  const paintOverlay = (frame: TrackingFrame | null, persona: PersonaId, strength: number) => {
    const ctx = ctxOf(overlay, 'overlay');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, size.width, size.height);
    // strength 0: the clear still happens, nothing is drawn.
    if (frame?.face && strength > 0) drawOverlay(ctx, persona, frame.face, size, strength);
    ctx.restore();
    overlay.__dirty = true;
  };

  const update = (frame: TrackingFrame | null, scene: SceneState, t: number, look: LookSettings = DEFAULT_LOOK) => {
    personaId = scene.persona;
    const strength = overlayStrengthOf(look);
    const faceX = faceCentreX(frame);
    const bs = backdropSignature(scene, size, t, reducedMotion, faceX);
    if (bs !== backdropSig) { backdropSig = bs; paintBackdrop(scene.persona, t, faceX); }
    const os = overlaySignature(frame, scene, size, t, strength);
    if (os !== overlaySig) { overlaySig = os; paintOverlay(frame, scene.persona, strength); }
  };

  return {
    resize,
    update,
    get overlay() { return overlay as unknown as PersonaLayerHandle['overlay']; },
    get backdrop() { return backdrop as unknown as PersonaLayerHandle['backdrop']; },
    get personaId() { return personaId; },
    setReducedMotion(v: boolean) { if (v !== reducedMotion) { reducedMotion = v; backdropSig = ''; } },
    invalidate,
  };
}
