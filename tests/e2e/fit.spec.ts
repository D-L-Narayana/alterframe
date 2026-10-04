/**
 * Display fit (owner: W10). 390×844 portrait viewport with the 16:9 fake camera:
 *  - Settings → Display fit → Fit: the letterbox bars (top/bottom) are black while the centre shows video;
 *  - Fill (default): the same rows are not black (cover crops instead of letterboxing).
 * Pixel assertions through `stagePixels`; geometry from `fitRect`/`containBars` (one fit, centred).
 */
import { test, expect } from '@playwright/test';
import { startMockSession, openSettings, closeDialog, chooseSegment, canvasBox, stagePixels, regionMean, regionFraction, containBars, fitRect, waitFrames, NAMES } from './helpers/app';
import { holdSample, POSES } from './helpers/mockTracking';

const VIDEO = { w: 640, h: 360 };
const isBlack = (r: number, g: number, b: number) => r < 12 && g < 12 && b < 12;

test.describe('display fit', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Fit letterboxes: black bars at the top and bottom, video in the centre; Fill shows video there again', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const dialog = await openSettings(page);
    await expect(dialog.getByRole('radiogroup', { name: NAMES.displayFit, exact: true })).toBeVisible();
    await chooseSegment(dialog, NAMES.displayFit, NAMES.fitOptions.fit);
    await closeDialog(page);
    await waitFrames(page, 10);

    const box = await canvasBox(page);
    const { axis, bars } = containBars({ x: 0, y: 0, width: box.width, height: box.height }, VIDEO.w, VIDEO.h);
    expect(axis, 'portrait canvas + landscape video → horizontal bars').toBe('y');
    const content = fitRect('contain', { x: 0, y: 0, width: box.width, height: box.height }, VIDEO.w, VIDEO.h);
    expect(content.w, 'the whole frame width is visible').toBeCloseTo(box.width, 0);

    const px = await stagePixels(page, 195);
    for (const bar of bars) {
      // Stay 2 % away from the content edge so anti-aliasing does not count.
      const inner = bar.y0 === 0 ? { ...bar, y1: bar.y1 - 0.02 } : { ...bar, y0: bar.y0 + 0.02 };
      expect(regionFraction(px, inner, isBlack), `letterbox bar ${JSON.stringify(bar)} is black`).toBeGreaterThan(0.98);
    }
    const centre = { x0: 0.2, y0: 0.45, x1: 0.8, y1: 0.55 };
    const [r, g, b] = regionMean(px, centre);
    expect((r + g + b) / 3, 'video content in the centre is not black').toBeGreaterThan(20);
    expect(regionFraction(px, centre, isBlack), 'centre is mostly non-black').toBeLessThan(0.2);

    // Back to Fill: cover crops the sides, so the former bar rows now show video.
    await openSettings(page);
    await chooseSegment(page.getByRole('dialog', { name: NAMES.settingsTitle }), NAMES.displayFit, NAMES.fitOptions.fill);
    await closeDialog(page);
    await waitFrames(page, 10);
    const filled = await stagePixels(page, 195);
    for (const bar of bars) {
      const inner = bar.y0 === 0 ? { ...bar, y1: bar.y1 - 0.02 } : { ...bar, y0: bar.y0 + 0.02 };
      expect(regionFraction(filled, inner, isBlack), `Fill shows video where the bar was ${JSON.stringify(bar)}`).toBeLessThan(0.5);
    }
  });

  test('the default is Fill (cover): no black bars without changing settings', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const dialog = await openSettings(page);
    const group = dialog.getByRole('radiogroup', { name: NAMES.displayFit, exact: true });
    await expect(group.getByRole('radio', { name: NAMES.fitOptions.fill, exact: true })).toBeChecked();
    await closeDialog(page);
    await waitFrames(page, 5);
    const box = await canvasBox(page);
    const { bars } = containBars({ x: 0, y: 0, width: box.width, height: box.height }, VIDEO.w, VIDEO.h);
    const px = await stagePixels(page, 195);
    for (const bar of bars) {
      const inner = bar.y0 === 0 ? { ...bar, y1: bar.y1 - 0.02 } : { ...bar, y0: bar.y0 + 0.02 };
      expect(regionFraction(px, inner, isBlack)).toBeLessThan(0.5);
    }
  });
});
