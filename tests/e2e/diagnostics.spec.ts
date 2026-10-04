/**
 * Diagnostics panel (owner: W10). Settings → Diagnostics: the `<dl>` rows are present, "Tracking" is
 * non-empty, and "Copy diagnostics" puts valid JSON (with `fps` and `quality`) on the clipboard.
 * Clipboard permissions are granted for this spec only. Mock tracking, Chromium fake camera.
 */
import { test, expect } from '@playwright/test';
import { startMockSession, openSettings, NAMES } from './helpers/app';
import { holdSample, POSES } from './helpers/mockTracking';

test.use({ permissions: ['camera', 'clipboard-read', 'clipboard-write'] });

test.describe('diagnostics', () => {
  test('rows present, Tracking row non-empty, values refresh while the sheet is open', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const dialog = await openSettings(page);
    await expect(dialog.getByRole('heading', { name: NAMES.groups.diagnostics, exact: true })).toBeVisible();

    const dl = dialog.locator('dl');
    await expect(dl).toBeVisible();
    const terms = await dl.locator('dt').allTextContents();
    expect(terms).toEqual([...NAMES.diagnosticsRows]);
    const row = (term: string) => dl.locator('div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${term}$`) }) }).locator('dd');
    await expect(row('Tracking')).not.toHaveText('');
    await expect(row('Tracking')).toHaveText(/Ready|Loading \d+%|Failed/);
    await expect(row('Source')).toHaveText(/camera · ready · \d+×\d+/);
    await expect(row('Quality')).toHaveText(/render \d+% · segmentation every \d · face every \d · tracking ≤ \d+p/);
    await expect(row('GPU time')).toHaveText(/^(n\/a|\d+\.\d\d ms)$/);
    const frame0 = await row('Frame').textContent();
    await expect.poll(() => row('Frame').textContent(), { timeout: 10_000, message: 'Frame row refreshes (2 Hz poll)' }).not.toBe(frame0);
  });

  test('Copy diagnostics writes JSON with fps and quality to the clipboard', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const dialog = await openSettings(page);
    const copy = dialog.getByRole('button', { name: NAMES.copyDiagnostics, exact: true });
    await expect(copy).toBeVisible();
    await copy.click();
    // The toast text is announced through the always-mounted polite live region.
    await expect(page.locator('[aria-live="polite"]')).toContainText('Diagnostics copied');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(typeof json.fps).toBe('number');
    expect(json.quality).toMatchObject({ renderScale: expect.any(Number), segmentationStride: expect.any(Number), inferenceMaxHeight: expect.any(Number), faceStride: expect.any(Number) });
    expect(json.tracker).toMatchObject({ ready: expect.any(Boolean), progress: expect.any(Number) });
    expect(json.source).toMatchObject({ kind: 'camera' });
  });
});
