import type { Size, Vec2 } from '@/types';

/** Pure pixel-space layout math for the HUD (unit tested; no canvas access). */

/** Font size = 1.85 % of canvas height (≈ 20 px at 1080p, matching the reference). */
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
/** Manual letter-spacing as a fraction of the font size (plan §3: 0.04em). */
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
