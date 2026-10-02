import type { Rect, Size, Vec2 } from '@/types';

/**
 * Coordinate convention (binding, agreed with lead after the full reference pass):
 *
 *  • The tracker (W3) emits landmarks normalized to the INTRINSIC VIDEO FRAME
 *    (`video.videoWidth × videoHeight`), already mirrored (x → 1 − x).
 *  • Overlay canvases (W6 persona, W8 HUD) are sized to that SAME intrinsic
 *    frame — the runtime calls `resize({ width: videoWidth, height: videoHeight })`
 *    — so `px = x · videoWidth` is exact and nothing is stretched.
 *  • The compositor (W4) composites base + window + overlays in video space and
 *    applies ONE `object-fit: cover` mapping when presenting into the canvas
 *    backing store (`renderer.resize(cssW, cssH, dpr)`, `RenderInputs.videoWidth/Height`).
 *  • Mirroring happens exactly once per stream: W3 mirrors landmarks + mask
 *    columns, W4 flips the video UV. Nobody else mirrors.
 *
 * The runtime therefore does NOT remap tracking output. The helpers below are
 * the reference implementation of that single cover-fit, exported for the
 * media harness overlay, for pointer→video hit-testing in UI code, and so W4's
 * unit tests can cross-check against one shared definition.
 */
export interface CoverFit {
  /** Uniform scale from video pixels to display pixels. */
  scale: number;
  /** Display-pixel offset of the video's top-left corner (≤ 0 on the cropped axis). */
  offsetX: number;
  offsetY: number;
  /** Portion of the video (normalized video coords) visible on the display. */
  visible: Rect;
  /** Normalized video → normalized display: x' = x·scaleX + shiftX. */
  scaleX: number;
  scaleY: number;
  shiftX: number;
  shiftY: number;
  /** Aspect ratios match (within 1e-4): mapping is identity. */
  identity: boolean;
  display: Size;
  video: Size;
}

const IDENTITY_EPS = 1e-4;

/** `object-fit: cover` of `video` into `display`; both in pixels (only aspect matters for the normalized terms). */
export function computeCoverFit(video: Size, display: Size): CoverFit {
  const vw = Math.max(1, video.width);
  const vh = Math.max(1, video.height);
  const dw = Math.max(1, display.width);
  const dh = Math.max(1, display.height);
  const scale = Math.max(dw / vw, dh / vh);
  const drawnW = vw * scale;
  const drawnH = vh * scale;
  const offsetX = (dw - drawnW) / 2;
  const offsetY = (dh - drawnH) / 2;
  const scaleX = drawnW / dw;
  const scaleY = drawnH / dh;
  const shiftX = offsetX / dw;
  const shiftY = offsetY / dh;
  const visible: Rect = { x: -offsetX / drawnW, y: -offsetY / drawnH, w: dw / drawnW, h: dh / drawnH };
  const identity = Math.abs(scaleX - 1) < IDENTITY_EPS && Math.abs(scaleY - 1) < IDENTITY_EPS;
  return { scale, offsetX, offsetY, visible, scaleX, scaleY, shiftX, shiftY, identity, display: { width: dw, height: dh }, video: { width: vw, height: vh } };
}

/** Normalized video point → normalized display point (may leave [0,1] when cropped). */
export function videoToDisplay(p: Vec2, fit: CoverFit): Vec2 {
  return { x: p.x * fit.scaleX + fit.shiftX, y: p.y * fit.scaleY + fit.shiftY };
}

/** Normalized display point (e.g. pointer / canvas px ÷ size) → normalized video point. */
export function displayToVideo(p: Vec2, fit: CoverFit): Vec2 {
  return { x: (p.x - fit.shiftX) / fit.scaleX, y: (p.y - fit.shiftY) / fit.scaleY };
}

/** Intrinsic frame size for overlay canvases; falls back to 1280×720 until metadata arrives. */
export function overlaySizeFor(videoWidth: number, videoHeight: number): Size {
  return videoWidth > 0 && videoHeight > 0 ? { width: videoWidth, height: videoHeight } : { width: 1280, height: 720 };
}
