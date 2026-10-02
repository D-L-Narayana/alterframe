/**
 * Recorder (owner: W10): R starts/stops recording and produces a download > 0 bytes;
 * S produces a PNG snapshot download. Runs in Chromium with MediaRecorder (WebM).
 */
import { test, expect } from '@playwright/test';
import { startMockSession, SEL } from './helpers/app';
import { holdSample, POSES } from './helpers/mockTracking';

test.describe('recorder', () => {
  test('record 2 s → download with size > 0 and a media extension', async ({ page }) => {
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const record = page.getByRole('button', { name: SEL.record });
    await expect(record, 'Record control (contract §W1.7)').toBeVisible();

    await record.click();
    await expect(page.getByText(/\d\d:\d\d/).first(), 'elapsed mm:ss while recording').toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2000);
    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await page.getByRole('button', { name: /stop|record/i }).first().click();
    const download = await downloadPromise;
    const name = download.suggestedFilename();
    expect(name).toMatch(/^alterframe-\d{8}-\d{6}\.(webm|mp4)$/);
    const path = await download.path();
    expect(path).toBeTruthy();
    const { statSync } = await import('node:fs');
    expect(statSync(path!).size, 'recorded blob is non-empty').toBeGreaterThan(1000);
  });

  test('S key saves a PNG snapshot', async ({ page }) => {
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await page.keyboard.press('s');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^alterframe-\d{8}-\d{6}\.png$/);
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync(path!);
    // PNG signature.
    expect(Array.from(buf.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(buf.length).toBeGreaterThan(1000);
  });
});
