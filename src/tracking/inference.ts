/**
 * Inference-input helpers (pure, no MediaPipe imports).
 *
 * `inferenceMaxHeight` is a quality rung: a source taller than the cap is resampled ONCE per
 * analysed frame into an internal canvas and that canvas is what the hand, face and segmentation
 * tasks see. Nothing downstream needs remapping because MediaPipe reports landmarks in
 * normalized [0,1] coordinates of whatever image it was given, and the mask is resampled to the
 * fixed `MASK_SIZE` square anyway — the downscale only changes the pixel budget of the models.
 */
import type { Size } from '../types/geometry';

/** Canvas kinds MediaPipe accepts as an `ImageSource`. */
export type InferenceCanvas = OffscreenCanvas | HTMLCanvasElement;

/**
 * Factory for the internal downscale canvas. Returning null means "no canvas implementation
 * here" (plain Node); the tracker then feeds the source at native size and records a warning.
 */
export type InferenceCanvasFactory = (width: number, height: number) => InferenceCanvas | null;

/**
 * Nearest even integer (halves round up), never below 2. Even dimensions keep the texture upload
 * and the models' internal resizes on 2-pixel boundaries (no half-texel row at the edge).
 */
export function evenSize(n: number): number {
  const even = 2 * Math.round(n / 2);
  return even < 2 ? 2 : even;
}

/**
 * Size the models should see for a `width`×`height` source under `maxHeight`, or null when the
 * source is not taller than the cap (feed it directly, no copy) or the inputs are degenerate.
 * Height = cap, width by aspect, both rounded to even numbers.
 */
export function inferenceTarget(width: number, height: number, maxHeight: number): Size | null {
  if (!(width > 0) || !(height > 0) || !(maxHeight > 0)) return null;
  if (height <= maxHeight) return null;
  return { width: evenSize((width * maxHeight) / height), height: evenSize(maxHeight) };
}

/** `OffscreenCanvas` when available (no DOM node, works in workers), else a detached `<canvas>`, else null. */
export function createDefaultInferenceCanvas(width: number, height: number): InferenceCanvas | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  } catch {
    /* fall through to the DOM canvas */
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  return null;
}
