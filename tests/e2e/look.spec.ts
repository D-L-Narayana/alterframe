/**
 * Look tuning (owner: W10). Mock tracking holds the wide window; the portrait persona (paper + ink)
 * is active. "Ink thickness" at its maximum (keyboard End on the slider) thickens the Sobel lines, so
 * the fraction of dark pixels INSIDE the window increases versus the default; "Reset look" restores
 * the default fraction. Pixel assertions only — the default look must equal the visual baselines (lead).
 */
import { test, expect } from '@playwright/test';
import { startMockSession, openSettings, closeDialog, setSliderExtreme, canvasBox, stagePixels, regionFraction, coverRect, waitFrames, NAMES } from './helpers/app';
import { holdSample, POSES, type MockSample } from './helpers/mockTracking';

const isDark = (r: number, g: number, b: number) => r < 70 && g < 70 && b < 70;

/** Canvas-fraction rect of the window interior (bbox of the tips, inset), through cover-fit. */
function windowRect(sample: MockSample, box: { width: number; height: number }) {
  const pts = sample.hands.flatMap((h) => [h.indexTip, h.thumbTip]);
  const inset = 0.03;
  const bb = { x0: Math.min(...pts.map((p) => p.x)) + inset, y0: Math.min(...pts.map((p) => p.y)) + inset, x1: Math.max(...pts.map((p) => p.x)) - inset, y1: Math.max(...pts.map((p) => p.y)) - inset };
  const r = coverRect({ x: 0, y: 0, width: box.width, height: box.height }, 640, 360);
  const f = (nx: number, ny: number) => ({ x: (r.x + nx * r.w) / box.width, y: (r.y + ny * r.h) / box.height });
  const a = f(bb.x0, bb.y0);
  const b = f(bb.x1, bb.y1);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

test.describe('look settings', () => {
  test('Ink thickness at maximum raises the dark-pixel fraction inside the window; Reset look restores it', async ({ page }) => {
    test.slow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    await page.keyboard.press('1'); // portrait persona: paper + ink inside the window
    await page.keyboard.press('h'); // HUD off: no callouts in the measured region
    await waitFrames(page, 20);
    const box = await canvasBox(page);
    const rect = windowRect(POSES.wide, box);

    const dialog = await openSettings(page);
    await expect(dialog.getByRole('slider', { name: NAMES.look.inkThickness, exact: true })).toHaveValue('1');
    await closeDialog(page);
    await waitFrames(page, 10);
    const before = regionFraction(await stagePixels(page, Math.round(box.width)), rect, isDark);

    await openSettings(page);
    const s = page.getByRole('dialog', { name: NAMES.settingsTitle }).getByRole('slider', { name: NAMES.look.inkThickness, exact: true });
    await setSliderExtreme(s, 'max');
    await expect(s).toHaveValue('3');
    await closeDialog(page);
    await waitFrames(page, 20);
    const thick = regionFraction(await stagePixels(page, Math.round(box.width)), rect, isDark);
    expect(thick, `dark fraction inside the window: default ${before.toFixed(3)} → max ink ${thick.toFixed(3)}`).toBeGreaterThan(before * 1.3 + 0.01);

    await openSettings(page);
    await page.getByRole('dialog', { name: NAMES.settingsTitle }).getByRole('button', { name: NAMES.look.reset, exact: true }).click();
    await expect(page.getByRole('dialog', { name: NAMES.settingsTitle }).getByRole('slider', { name: NAMES.look.inkThickness, exact: true })).toHaveValue('1');
    await closeDialog(page);
    await waitFrames(page, 20);
    const reset = regionFraction(await stagePixels(page, Math.round(box.width)), rect, isDark);
    expect(Math.abs(reset - before), 'Reset look returns to the default render').toBeLessThan(0.03 + before * 0.25);
  });

  test('every Look slider is present with the documented ranges and the default values', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    const dialog = await openSettings(page);
    const expectSlider = async (name: string, min: string, max: string, value: string) => {
      const el = dialog.getByRole('slider', { name, exact: true });
      await expect(el).toHaveAttribute('min', min);
      await expect(el).toHaveAttribute('max', max);
      await expect(el).toHaveValue(value);
    };
    await expectSlider(NAMES.look.inkThickness, '0.25', '3', '1');
    await expectSlider(NAMES.look.inkThreshold, '0.25', '3', '1');
    await expectSlider(NAMES.look.halftone, '0', '2', '1');
    await expectSlider(NAMES.look.saturation, '0', '2', '1');
    await expectSlider(NAMES.look.bands, '3', '8', '6');
    await expectSlider(NAMES.look.grain, '0', '3', '1');
    await expectSlider(NAMES.look.overlayStrength, '0', '1', '1');
    await expect(dialog.getByRole('button', { name: NAMES.look.reset, exact: true })).toBeVisible();
  });
});
