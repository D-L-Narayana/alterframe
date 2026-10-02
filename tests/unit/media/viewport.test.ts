import { describe, it, expect } from 'vitest';
import { computeCoverFit, videoToDisplay, displayToVideo, overlaySizeFor } from '@/runtime/viewport';

describe('computeCoverFit', () => {
  it('is identity when aspects match', () => {
    const fit = computeCoverFit({ width: 1280, height: 720 }, { width: 1920, height: 1080 });
    expect(fit.identity).toBe(true);
    expect(fit.scale).toBeCloseTo(1.5);
    expect(fit.offsetX).toBeCloseTo(0);
    expect(fit.offsetY).toBeCloseTo(0);
    expect(videoToDisplay({ x: 0.2, y: 0.5 }, fit)).toEqual({ x: 0.2, y: 0.5 });
  });

  it('crops the sides of a 16:9 video on a 9:16 display (phone) and keeps the centre fixed', () => {
    const fit = computeCoverFit({ width: 1280, height: 720 }, { width: 390, height: 844 });
    expect(fit.identity).toBe(false);
    expect(fit.scale).toBeCloseTo(844 / 720);
    expect(fit.offsetY).toBeCloseTo(0);
    expect(fit.offsetX).toBeLessThan(0);
    expect(videoToDisplay({ x: 0.5, y: 0.5 }, fit)).toEqual({ x: expect.closeTo(0.5, 6), y: expect.closeTo(0.5, 6) });
    // A hand at 20 % of the video is off-screen to the left on the phone.
    expect(videoToDisplay({ x: 0.2, y: 0.5 }, fit).x).toBeLessThan(0);
    // Visible slice is centred and narrower than the video.
    expect(fit.visible.w).toBeCloseTo(390 / (1280 * fit.scale));
    expect(fit.visible.x).toBeCloseTo((1 - fit.visible.w) / 2);
    expect(fit.visible.h).toBeCloseTo(1);
  });

  it('crops top/bottom of a 4:3 video on an ultra-wide display', () => {
    const fit = computeCoverFit({ width: 640, height: 480 }, { width: 2560, height: 1080 });
    expect(fit.offsetX).toBeCloseTo(0);
    expect(fit.offsetY).toBeLessThan(0);
    expect(fit.visible.w).toBeCloseTo(1);
    expect(fit.visible.h).toBeLessThan(1);
  });

  it('displayToVideo inverts videoToDisplay', () => {
    const fit = computeCoverFit({ width: 1280, height: 720 }, { width: 1024, height: 1024 });
    for (const p of [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.5 }, { x: 0.83, y: 0.21 }]) {
      const back = displayToVideo(videoToDisplay(p, fit), fit);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('mirroring commutes with cover-fit (horizontal symmetry about the centre)', () => {
    const fit = computeCoverFit({ width: 1280, height: 720 }, { width: 390, height: 844 });
    const p = { x: 0.2, y: 0.4 };
    const mirroredThenFit = videoToDisplay({ x: 1 - p.x, y: p.y }, fit);
    const fitThenMirrored = videoToDisplay(p, fit);
    expect(mirroredThenFit.x).toBeCloseTo(1 - fitThenMirrored.x, 9);
  });

  it('guards against zero sizes', () => {
    const fit = computeCoverFit({ width: 0, height: 0 }, { width: 0, height: 0 });
    expect(Number.isFinite(fit.scale)).toBe(true);
  });

  it('overlaySizeFor falls back to 1280x720 before metadata', () => {
    expect(overlaySizeFor(0, 0)).toEqual({ width: 1280, height: 720 });
    expect(overlaySizeFor(640, 480)).toEqual({ width: 640, height: 480 });
  });
});
