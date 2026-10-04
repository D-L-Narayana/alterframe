/**
 * Hold-still capture (owner: W10). Mock tracking holds POSES.wide perfectly still (identical corners
 * every frame): with Settings → Hold still to capture → Snapshot, the dwell detector fires after the
 * hold time and a PNG download arrives without any key press. With Off, holding still does nothing.
 */
import { test, expect } from '@playwright/test';
import { startMockSession, openSettings, closeDialog, chooseSegment, holdStill, NAMES } from './helpers/app';
import { holdSample, POSES, stopMock } from './helpers/mockTracking';

test.describe('hold-still capture', () => {
  test('Hold still → Snapshot: a still wide pose produces a PNG download within ~4 s', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    const dialog = await openSettings(page);
    await expect(dialog.getByRole('radiogroup', { name: NAMES.holdStill, exact: true })).toBeVisible();
    await chooseSegment(dialog, NAMES.holdStill, NAMES.holdStillOptions.snapshot);
    const hold = dialog.getByRole('slider', { name: NAMES.holdTime, exact: true });
    await expect(hold, 'Hold time enabled once the action is on').toBeEnabled();
    await expect(hold).toHaveValue('1500');
    await closeDialog(page);

    let downloads = 0;
    page.on('download', () => downloads++);
    const download = page.waitForEvent('download', { timeout: 20_000 });
    const t0 = await holdStill(page, POSES.wide);
    const file = await download;
    const elapsed = await page.evaluate((start) => performance.now() - start, t0);
    expect(file.suggestedFilename()).toMatch(/^alterframe-\d{8}-\d{6}\.png$/);
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync((await file.path())!);
    expect(Array.from(buf.subarray(0, 8)), 'PNG signature').toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(elapsed, 'fired after the 1.5 s hold, within ~4 s (SwiftShader frame pacing)').toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(4_500);
    // One stillness episode → exactly one capture (no re-fire while the pose stays still).
    await page.waitForTimeout(2500);
    expect(downloads, 'a single still episode captures once').toBe(1);
    await stopMock(page);
  });

  test('Hold still → Off: holding still never captures', async ({ page }) => {
    test.slow(); // SwiftShader: session start + settings alone take ~40 s on a loaded machine
    await startMockSession(page);
    const dialog = await openSettings(page);
    const group = dialog.getByRole('radiogroup', { name: NAMES.holdStill, exact: true });
    await expect(group.getByRole('radio', { name: NAMES.holdStillOptions.off, exact: true }), 'default is Off').toBeChecked();
    await expect(dialog.getByRole('slider', { name: NAMES.holdTime, exact: true })).toBeDisabled();
    await closeDialog(page);
    let downloads = 0;
    page.on('download', () => downloads++);
    await holdSample(page, POSES.wide);
    await page.waitForTimeout(4000);
    expect(downloads).toBe(0);
  });
});
