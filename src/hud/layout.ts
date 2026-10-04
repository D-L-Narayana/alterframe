import type { Size, Vec2 } from '@/types';

/** Pure pixel-space layout math for the HUD (unit tested; no canvas access). */

/** Font size = 1.85 % of canvas height (≈ 20 px at 1080p, matching the source footage). */
export const FONT_HEIGHT_RATIO = 0.0185;
export const MIN_FONT_PX = 11;
/** Label baseline sits this far above the anchor. */
export const LABEL_BASELINE_GAP_PX = 6;
/** Anchors right of this normalized x get right-aligned labels so text stays in frame. */
export const RIGHT_ALIGN_THRESHOLD_X = 0.7;
/** Bracket arm length. */
export const BRACKET_SIZE_PX = 6;
/** Minimum distance from any canvas edge for text/brackets. */
export const EDGE_PAD_PX = 4;
/** Manual letter-spacing as a fraction of the font size (0.04 em). */
export const TRACKING_EM = 0.04;
/** Record dot radius-doubling size and 1 Hz blink period. */
export const RECORD_DOT_PX = 10;
export const BLINK_PERIOD_MS = 1000;

export interface Segment { x1: number; y1: number; x2: number; y2: number }
export interface LabelPlacement { x: number; y: number; align: 'left' | 'right'; below: boolean }

export function hudFontPx(canvasHeight: number): number {
  const px = Math.round(FONT_HEIGHT_RATIO * (Number.isFinite(canvasHeight) ? canvasHeight : 0));
  return Math.max(MIN_FONT_PX, px);
}

export function toPx(p: Vec2, size: Size): Vec2 {
  return { x: p.x * size.width, y: p.y * size.height };
}

export function clampToBounds(p: Vec2, size: Size, pad = EDGE_PAD_PX): Vec2 {
  const maxX = Math.max(pad, size.width - pad);
  const maxY = Math.max(pad, size.height - pad);
  return { x: Math.min(maxX, Math.max(pad, p.x)), y: Math.min(maxY, Math.max(pad, p.y)) };
}

/**
 * Where to put a code label for an anchor (normalized). Returns the text origin in
 * pixels, alignment, and whether it was flipped below the anchor for lack of room.
 * `textWidth` is the already-measured (tracked) width in px.
 */
export function placeLabel(anchor: Vec2, textWidth: number, fontPx: number, size: Size): LabelPlacement {
  const px = toPx(anchor, size);
  const align: 'left' | 'right' = anchor.x > RIGHT_ALIGN_THRESHOLD_X ? 'right' : 'left';
  let x = Math.round(px.x);
  // Horizontal clamp: keep [left, right] of the glyph box inside the padded canvas.
  if (align === 'left') {
    x = Math.min(x, size.width - EDGE_PAD_PX - textWidth);
    x = Math.max(x, EDGE_PAD_PX);
  } else {
    x = Math.max(x, EDGE_PAD_PX + textWidth);
    x = Math.min(x, size.width - EDGE_PAD_PX);
  }
  // Vertical: baseline 6 px above the anchor; cap height ≈ 0.75 em for Inter.
  const capHeight = fontPx * 0.75;
  let y = Math.round(px.y) - LABEL_BASELINE_GAP_PX;
  let below = false;
  if (y - capHeight < EDGE_PAD_PX) {
    // No room above: put the text under the anchor, below the bracket's downward arm.
    below = true;
    y = Math.round(px.y) + BRACKET_SIZE_PX + LABEL_BASELINE_GAP_PX + Math.ceil(capHeight);
    y = Math.max(y, EDGE_PAD_PX + fontPx);
  }
  y = Math.min(y, size.height - EDGE_PAD_PX);
  return { x, y, align, below };
}

/**
 * Two arms of the L-shaped bracket glyph at an anchor (pixels). `dir` = +1 opens
 * right/down (label on the left side of the frame), −1 mirrors horizontally for
 * right-aligned labels so the bracket "points" at its text.
 */
export function bracketSegments(anchorPx: Vec2, dir: 1 | -1, size = BRACKET_SIZE_PX): [Segment, Segment] {
  const { x, y } = anchorPx;
  return [
    { x1: x, y1: y, x2: x + dir * size, y2: y },
    { x1: x, y1: y, x2: x, y2: y + size },
  ];
}

/** 1 Hz blink, 50 % duty; always on under reduced motion. */
export function blinkOn(t: number, reducedMotion: boolean): boolean {
  if (reducedMotion || !Number.isFinite(t)) return true;
  const phase = ((t % BLINK_PERIOD_MS) + BLINK_PERIOD_MS) % BLINK_PERIOD_MS;
  return phase < BLINK_PERIOD_MS / 2;
}

/** Width of a manually tracked string given per-glyph advances. */
export function trackedWidth(glyphWidths: readonly number[], tracking: number): number {
  if (glyphWidths.length === 0) return 0;
  let sum = 0;
  for (const w of glyphWidths) sum += w;
  return sum + tracking * (glyphWidths.length - 1);
}

export function fpsBadgeText(fps: number): string {
  return `${Math.round(fps)} fps`;
}

// ----------------------------------------------------------------- countdown

/** Cap height of the HUD face as a fraction of the font size (Inter ≈ 0.75 em). */
export const CAP_HEIGHT_EM = 0.75;
/** Countdown numeral = 18 % of canvas height, never below 48 px. */
export const COUNTDOWN_FONT_HEIGHT_RATIO = 0.18;
export const COUNTDOWN_MIN_FONT_PX = 48;
/** The countdown ignores the window opacity and is drawn at this alpha. */
export const COUNTDOWN_ALPHA = 0.9;
/** Small label drawn above the numeral, per countdown action. */
export const COUNTDOWN_LABELS = { record: 'RECORDING IN', snapshot: 'SNAPSHOT IN' } as const;
/** Progress (0..1) is quantized into this many steps (5 %) for the dedupe key and the drawn arcs. */
export const PROGRESS_BUCKETS = 20;

export interface CountdownLayout {
  /** Canvas centre in pixels (numeral and ring are centred here). */
  center: Vec2;
  fontPx: number;
  /** Numeral baseline: the cap height is centred on `center.y`. */
  baselineY: number;
  labelFontPx: number;
  labelBaselineY: number;
  ringRadius: number;
}

/** Gap between the label baseline and the numeral's cap top, in numeral ems. */
export const COUNTDOWN_LABEL_GAP_EM = 0.12;
/** Radius of the thin progress arc around the numeral, in numeral ems (clears two digits). */
export const COUNTDOWN_RING_RADIUS_EM = 0.8;
/** Stroke width of the progress arcs (countdown ring and dwell ring), device px. */
export const RING_LINE_PX = 1.5;
/** Arcs start at 12 o'clock and run clockwise (canvas y grows downwards). */
export const RING_START_ANGLE = -Math.PI / 2;

export function countdownFontPx(canvasHeight: number): number {
  const px = Math.round(COUNTDOWN_FONT_HEIGHT_RATIO * (Number.isFinite(canvasHeight) ? canvasHeight : 0));
  return Math.max(COUNTDOWN_MIN_FONT_PX, px);
}

/** Numeral, label and ring geometry for a canvas of `size` (device px). */
export function countdownLayout(size: Size): CountdownLayout {
  const center = { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
  const fontPx = countdownFontPx(size.height);
  const capHeight = fontPx * CAP_HEIGHT_EM;
  const baselineY = Math.round(center.y + capHeight / 2);
  const labelFontPx = hudFontPx(size.height);
  const labelBaselineY = Math.round(baselineY - capHeight - fontPx * COUNTDOWN_LABEL_GAP_EM);
  // Keep the ring inside the padded canvas on narrow (portrait) frames.
  const fit = Math.floor(Math.min(size.width, size.height) / 2) - EDGE_PAD_PX;
  const ringRadius = Math.max(1, Math.min(Math.round(fontPx * COUNTDOWN_RING_RADIUS_EM), fit));
  return { center, fontPx, baselineY, labelFontPx, labelBaselineY, ringRadius };
}

/** Numeral text: whole seconds rounded up, never negative; empty when not finite (nothing drawn). */
export function countdownText(secondsLeft: number): string {
  if (!Number.isFinite(secondsLeft)) return '';
  return String(Math.max(0, Math.ceil(secondsLeft)));
}

/** Quantize 0..1 progress into 5 % steps (0..20); clamps the range, non-finite → 0. */
export function progressBucket(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.round(Math.min(1, Math.max(0, progress)) * PROGRESS_BUCKETS);
}

/**
 * End angle of a progress arc that starts at 12 o'clock. Uses the quantized
 * progress so that equal dedupe keys always draw equal arcs.
 */
export function arcEndAngle(progress: number): number {
  return RING_START_ANGLE + (progressBucket(progress) / PROGRESS_BUCKETS) * Math.PI * 2;
}

// ---------------------------------------------------------------- dwell ring

/** Hold-still ring radius at 720p; scales linearly with the canvas height. */
export const DWELL_RING_RADIUS_720_PX = 14;
/** Smallest ring that still reads as a ring on tiny canvases. */
export const DWELL_RING_MIN_PX = 4;

export function dwellRingRadiusPx(canvasHeight: number): number {
  const h = Number.isFinite(canvasHeight) ? canvasHeight : 0;
  return Math.max(DWELL_RING_MIN_PX, Math.round((DWELL_RING_RADIUS_720_PX * h) / 720));
}
