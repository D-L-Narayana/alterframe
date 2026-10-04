import { describe, it, expect } from 'vitest';
import {
  hudFontPx, placeLabel, bracketSegments, blinkOn, trackedWidth, clampToBounds,
  RIGHT_ALIGN_THRESHOLD_X, LABEL_BASELINE_GAP_PX, BRACKET_SIZE_PX, EDGE_PAD_PX, fpsBadgeText, toPx,
  countdownFontPx, countdownLayout, countdownText, progressBucket, arcEndAngle, dwellRingRadiusPx,
  COUNTDOWN_FONT_HEIGHT_RATIO, COUNTDOWN_MIN_FONT_PX, COUNTDOWN_ALPHA, COUNTDOWN_LABELS, CAP_HEIGHT_EM,
  DWELL_RING_RADIUS_720_PX, RING_LINE_PX, RING_START_ANGLE,
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

describe('countdown layout', () => {
  it('sizes the numeral at 18 % of canvas height, never below 48 px', () => {
    expect(COUNTDOWN_FONT_HEIGHT_RATIO).toBe(0.18);
    expect(COUNTDOWN_MIN_FONT_PX).toBe(48);
    expect(countdownFontPx(1080)).toBe(194);
    expect(countdownFontPx(720)).toBe(130);
    expect(countdownFontPx(200)).toBe(48);
    expect(countdownFontPx(Number.NaN)).toBe(48);
  });

  it('centres the numeral cap height on the canvas centre and stacks the label above it', () => {
    expect(CAP_HEIGHT_EM).toBe(0.75);
    const l = countdownLayout(SIZE);
    expect(l.center).toEqual({ x: 960, y: 540 });
    expect(l.fontPx).toBe(194);
    expect(l.baselineY).toBe(Math.round(540 + (194 * CAP_HEIGHT_EM) / 2));
    const capTop = l.baselineY - 194 * CAP_HEIGHT_EM;
    expect(l.labelFontPx).toBe(hudFontPx(1080));
    expect(l.labelBaselineY).toBeLessThan(capTop);
    expect(l.labelBaselineY).toBeGreaterThan(capTop - 194 * 0.25);
    // The progress ring clears a two-digit numeral yet stays well inside the frame.
    expect(l.ringRadius).toBeGreaterThan(194 * 0.65);
    expect(l.ringRadius).toBeLessThan(540);
  });

  it('is drawn at alpha 0.9 regardless of the window opacity', () => {
    expect(COUNTDOWN_ALPHA).toBe(0.9);
  });

  it('formats whole seconds, rounding up, never negative, blank when not finite', () => {
    expect(countdownText(3)).toBe('3');
    expect(countdownText(10)).toBe('10');
    expect(countdownText(2.2)).toBe('3');
    expect(countdownText(0)).toBe('0');
    expect(countdownText(-1)).toBe('0');
    expect(countdownText(Number.NaN)).toBe('');
  });

  it('has one label per action', () => {
    expect(COUNTDOWN_LABELS.record).toBe('RECORDING IN');
    expect(COUNTDOWN_LABELS.snapshot).toBe('SNAPSHOT IN');
  });
});

describe('progressBucket', () => {
  it('quantizes 0..1 into 5 % steps and clamps the range', () => {
    expect(progressBucket(0)).toBe(0);
    expect(progressBucket(0.10)).toBe(2);
    expect(progressBucket(0.12)).toBe(2);
    expect(progressBucket(0.16)).toBe(3);
    expect(progressBucket(1)).toBe(20);
    expect(progressBucket(1.7)).toBe(20);
    expect(progressBucket(-0.3)).toBe(0);
    expect(progressBucket(Number.NaN)).toBe(0);
  });
});

describe('progress arcs', () => {
  it('start at 12 o\'clock and end at progress × 360°, quantized to the dedupe bucket', () => {
    expect(RING_START_ANGLE).toBeCloseTo(-Math.PI / 2, 12);
    expect(RING_LINE_PX).toBe(1.5);
    expect(arcEndAngle(0)).toBeCloseTo(-Math.PI / 2, 12);
    expect(arcEndAngle(0.25)).toBeCloseTo(0, 12);
    expect(arcEndAngle(0.5)).toBeCloseTo(Math.PI / 2, 12);
    expect(arcEndAngle(1)).toBeCloseTo(Math.PI * 1.5, 12);
    // Same 5 % bucket ⇒ same arc, so a skipped redraw never hides a different ring.
    expect(arcEndAngle(0.26)).toBe(arcEndAngle(0.25));
  });
});

describe('dwellRingRadiusPx', () => {
  it('is 14 px at 720p and scales linearly with the canvas height', () => {
    expect(DWELL_RING_RADIUS_720_PX).toBe(14);
    expect(dwellRingRadiusPx(720)).toBe(14);
    expect(dwellRingRadiusPx(1080)).toBe(21);
    expect(dwellRingRadiusPx(360)).toBe(7);
  });
  it('stays a usable positive size for degenerate heights', () => {
    expect(dwellRingRadiusPx(0)).toBeGreaterThan(0);
    expect(dwellRingRadiusPx(Number.NaN)).toBeGreaterThan(0);
    expect(dwellRingRadiusPx(10)).toBeGreaterThan(0);
  });
});
