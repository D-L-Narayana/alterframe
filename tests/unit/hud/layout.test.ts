import { describe, it, expect } from 'vitest';
import {
  hudFontPx, placeLabel, bracketSegments, blinkOn, trackedWidth, clampToBounds,
  RIGHT_ALIGN_THRESHOLD_X, LABEL_BASELINE_GAP_PX, BRACKET_SIZE_PX, EDGE_PAD_PX, fpsBadgeText, toPx,
} from '../../../src/hud/layout';

const SIZE = { width: 1920, height: 1080 };

describe('hudFontPx', () => {
  it('is 1.85 % of canvas height, rounded', () => {
    expect(hudFontPx(1080)).toBe(20);
    expect(hudFontPx(720)).toBe(13);
  });
  it('never drops below a legible minimum', () => {
    expect(hudFontPx(100)).toBeGreaterThanOrEqual(11);
    expect(hudFontPx(0)).toBeGreaterThanOrEqual(11);
  });
});

describe('toPx', () => {
  it('maps normalized to pixel space', () => {
    expect(toPx({ x: 0.25, y: 0.5 }, SIZE)).toEqual({ x: 480, y: 540 });
  });
});

describe('placeLabel', () => {
  const fontPx = 20;
  it('left-aligns at the anchor with the baseline 6 px above when anchor is on the left', () => {
    expect(LABEL_BASELINE_GAP_PX).toBe(6);
    const p = placeLabel({ x: 0.3, y: 0.5 }, 100, fontPx, SIZE);
    expect(p.align).toBe('left');
    expect(p.x).toBe(576);
    expect(p.y).toBe(540 - 6);
    expect(p.below).toBe(false);
  });

  it('right-aligns when anchor.x > 0.7 so the text stays in frame', () => {
    expect(RIGHT_ALIGN_THRESHOLD_X).toBe(0.7);
    expect(placeLabel({ x: 0.7, y: 0.5 }, 100, fontPx, SIZE).align).toBe('left');
    const p = placeLabel({ x: 0.71, y: 0.5 }, 100, fontPx, SIZE);
    expect(p.align).toBe('right');
    expect(p.x).toBe(Math.round(0.71 * 1920));
  });

  it('clamps a left-aligned label whose text would overflow the right edge', () => {
    const p = placeLabel({ x: 0.69, y: 0.5 }, 1000, fontPx, SIZE);
    expect(p.align).toBe('left');
    expect(p.x + 1000).toBeLessThanOrEqual(SIZE.width - EDGE_PAD_PX);
  });

  it('clamps a right-aligned label whose text would overflow the left edge', () => {
    const p = placeLabel({ x: 0.72, y: 0.5 }, 1900, fontPx, SIZE);
    expect(p.align).toBe('right');
    expect(p.x - 1900).toBeGreaterThanOrEqual(EDGE_PAD_PX);
  });

  it('flips below the anchor when there is no room above', () => {
    const p = placeLabel({ x: 0.3, y: 0.005 }, 100, fontPx, SIZE);
    expect(p.below).toBe(true);
    expect(p.y).toBeGreaterThanOrEqual(fontPx + EDGE_PAD_PX);
    // the cap-top of the flipped text must clear the bracket's downward arm
    const anchorY = Math.round(0.005 * SIZE.height);
    expect(p.y - fontPx * 0.75).toBeGreaterThanOrEqual(anchorY + BRACKET_SIZE_PX + LABEL_BASELINE_GAP_PX);
  });

  it('keeps the baseline inside the canvas when the anchor is below the bottom edge', () => {
    const p = placeLabel({ x: 0.3, y: 1.2 }, 100, fontPx, SIZE);
    expect(p.y).toBeLessThanOrEqual(SIZE.height - EDGE_PAD_PX);
  });
});

describe('bracketSegments', () => {
  it('returns two 6 px arms forming an L that opens toward the label (right and down)', () => {
    expect(BRACKET_SIZE_PX).toBe(6);
    const segs = bracketSegments({ x: 100, y: 200 }, 1);
    expect(segs).toHaveLength(2);
    const [h, v] = segs;
    expect(h).toEqual({ x1: 100, y1: 200, x2: 106, y2: 200 });
    expect(v).toEqual({ x1: 100, y1: 200, x2: 100, y2: 206 });
  });
  it('mirrors horizontally when the label is right-aligned', () => {
    const [h] = bracketSegments({ x: 100, y: 200 }, -1);
    expect(h).toEqual({ x1: 100, y1: 200, x2: 94, y2: 200 });
  });
});

describe('blinkOn', () => {
  it('blinks at 1 Hz with 50 % duty', () => {
    expect(blinkOn(0, false)).toBe(true);
    expect(blinkOn(499, false)).toBe(true);
    expect(blinkOn(500, false)).toBe(false);
    expect(blinkOn(999, false)).toBe(false);
    expect(blinkOn(1000, false)).toBe(true);
  });
  it('stays solid under reduced motion', () => {
    expect(blinkOn(500, true)).toBe(true);
    expect(blinkOn(750, true)).toBe(true);
  });
});

describe('trackedWidth', () => {
  it('adds tracking between glyphs but not after the last one', () => {
    expect(trackedWidth([10, 10, 10], 2)).toBe(34);
    expect(trackedWidth([10], 2)).toBe(10);
    expect(trackedWidth([], 2)).toBe(0);
  });
});

describe('clampToBounds', () => {
  it('clamps points into the padded canvas', () => {
    expect(clampToBounds({ x: -5, y: 2000 }, SIZE)).toEqual({ x: EDGE_PAD_PX, y: SIZE.height - EDGE_PAD_PX });
    expect(clampToBounds({ x: 10, y: 10 }, SIZE)).toEqual({ x: 10, y: 10 });
  });
});

describe('fpsBadgeText', () => {
  it('rounds to a whole number', () => {
    expect(fpsBadgeText(59.6)).toBe('60 fps');
    expect(fpsBadgeText(0)).toBe('0 fps');
  });
});
