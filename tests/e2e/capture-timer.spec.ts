/**
 * Self-timer / auto-stop / timed recording (owner: W10). Mock tracking, Chromium fake camera.
 *  - Settings → Self-timer 3 s + Auto-stop 10 s → R → "Recording starts in N" → the recording starts
 *    ≥ 2.5 s later → a download arrives after the auto-stop without pressing R again;
 *  - T starts a timed recording (3 s when the Self-timer is Off);
 *  - Esc during the countdown cancels it and no download happens.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { startMockSession, openSettings, closeDialog, chooseSegment, NAMES } from './helpers/app';
import { holdSample, POSES } from './helpers/mockTracking';

/** Open Settings and assert the Capture controls are there; returns the dialog. */
async function captureSettings(page: Page): Promise<Locator> {
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('radiogroup', { name: NAMES.selfTimer, exact: true })).toBeVisible();
  await expect(dialog.getByRole('radiogroup', { name: NAMES.autoStop, exact: true })).toBeVisible();
  return dialog;
}

test.describe('self-timer and auto-stop', () => {
  test('Self-timer 3 s + Auto-stop 10 s: countdown status, delayed start, automatic download', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const dialog = await captureSettings(page);
    await chooseSegment(dialog, NAMES.selfTimer, '3 s');
    await chooseSegment(dialog, NAMES.autoStop, '10 s');
    await closeDialog(page);

    const download = page.waitForEvent('download', { timeout: 60_000 });
    const t0 = Date.now();
    await page.keyboard.press('r');
    const status = page.getByRole('status').filter({ hasText: NAMES.recordCountdown });
    await expect(status, 'countdown announced').toBeVisible({ timeout: 5_000 });
    await expect(status.getByRole('button', { name: NAMES.cancelCountdown })).toBeVisible();
    await expect(status).toHaveText(/Recording starts in [1-3]/);

    const indicator = page.locator('[aria-label^="Recording, "]');
    await expect(indicator, 'recording indicator appears after the countdown').toBeVisible({ timeout: 15_000 });
    const startedAfterMs = Date.now() - t0;
    expect(startedAfterMs, 'the recording did not start before the 3 s timer elapsed').toBeGreaterThanOrEqual(2_500);
    await expect(status, 'countdown status gone once recording').toHaveCount(0);
    await expect(indicator).toHaveAttribute('aria-label', /^Recording, \d\d:\d\d, stops in \d\d:\d\d$/);

    // No key press: the auto-stop ends the recording and the download arrives on its own.
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^alterframe-\d{8}-\d{6}\.(webm|mp4)$/);
    const path = await file.path();
    const { statSync } = await import('node:fs');
    expect(statSync(path!).size, 'auto-stopped recording is non-empty').toBeGreaterThan(1000);
    await expect(page.getByRole('button', { name: NAMES.startRecording }), 'recorder idle again').toBeVisible({ timeout: 15_000 });
  });

  test('T starts a timed recording (3 s when the Self-timer is Off) and R stops it', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const dialog = await captureSettings(page);
    await chooseSegment(dialog, NAMES.selfTimer, 'Off');
    await chooseSegment(dialog, NAMES.autoStop, 'Off');
    await closeDialog(page);

    const t0 = Date.now();
    await page.keyboard.press('t');
    const status = page.getByRole('status').filter({ hasText: NAMES.recordCountdown });
    await expect(status, 'T uses a 3 s timer even when the Self-timer is Off').toBeVisible({ timeout: 5_000 });
    const indicator = page.locator('[aria-label^="Recording, "]');
    await expect(indicator).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_500);
    await expect(indicator, 'no auto-stop armed').toHaveAttribute('aria-label', /^Recording, \d\d:\d\d$/);

    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('r');
    expect((await download).suggestedFilename()).toMatch(/^alterframe-\d{8}-\d{6}\.(webm|mp4)$/);
  });

  test('Esc during the countdown cancels it: no recording, no download', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const dialog = await captureSettings(page);
    await chooseSegment(dialog, NAMES.selfTimer, '5 s');
    await closeDialog(page);

    let downloads = 0;
    page.on('download', () => downloads++);
    await page.keyboard.press('r');
    const status = page.getByRole('status').filter({ hasText: NAMES.recordCountdown });
    await expect(status).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(status, 'Esc cancels the countdown').toHaveCount(0);
    await expect(page.locator('[aria-live="polite"]'), 'cancellation announced').toContainText('Countdown cancelled');
    // Wait past the original 5 s timer: nothing must start.
    await page.waitForTimeout(6000);
    await expect(page.locator('[aria-label^="Recording, "]'), 'no recording after a cancelled countdown').toHaveCount(0);
    await expect(page.getByRole('button', { name: NAMES.startRecording })).toBeVisible();
    expect(downloads, 'no download after a cancelled countdown').toBe(0);
  });

  test('S with a Self-timer announces "Snapshot in N" and saves after the countdown', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const dialog = await captureSettings(page);
    await chooseSegment(dialog, NAMES.selfTimer, '3 s');
    await closeDialog(page);
    const download = page.waitForEvent('download', { timeout: 30_000 });
    const t0 = Date.now();
    await page.keyboard.press('s');
    await expect(page.getByRole('status').filter({ hasText: NAMES.snapshotCountdown })).toBeVisible({ timeout: 5_000 });
    const file = await download;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_500);
    expect(file.suggestedFilename()).toMatch(/^alterframe-\d{8}-\d{6}\.png$/);
  });
});
