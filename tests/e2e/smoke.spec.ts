/**
 * Smoke (owner: W10): app loads, onboarding → camera (Chromium fake device fed by the generated
 * fixture) → stage canvas visible, fps badge updates, no console errors.
 *
 * NOTE: a passing smoke test proves wiring and rendering with a fake camera; it does not prove
 * real-camera tracking quality (the sandbox has no camera).
 */
import { test, expect } from '@playwright/test';
import { captureConsole, gotoApp, startCamera, SEL, stage, stagePixels, regionMean } from './helpers/app';

test.describe('smoke', () => {
  test('onboarding renders with privacy statement and both source actions', async ({ page }) => {
    const con = captureConsole(page);
    await gotoApp(page);
    await expect(page.getByRole('button', { name: SEL.useCamera })).toBeVisible();
    await expect(page.getByRole('button', { name: SEL.openFile })).toBeVisible();
    await expect(page.getByText(SEL.privacyLine)).toBeVisible();
    con.assertClean();
  });

  test('camera start shows the stage canvas and draws non-black frames', async ({ page }) => {
    const con = captureConsole(page);
    await gotoApp(page);
    const canvas = await startCamera(page);
    await expect(canvas).toHaveAttribute('aria-label', /.+/);
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(300);
    expect(box?.height ?? 0).toBeGreaterThan(200);

    // The fixture is a mid-grey scene; after a few frames the canvas must not be all black.
    await expect
      .poll(
        async () => {
          const px = await stagePixels(page, 160);
          const [r, g, b] = regionMean(px, { x0: 0, y0: 0, x1: 1, y1: 1 });
          return (r + g + b) / 3;
        },
        { timeout: 30_000, message: 'stage canvas shows video content (mean luma > 20)' },
      )
      .toBeGreaterThan(20);
    con.assertClean();
  });

  test('F toggles the fps badge; it mirrors the live frame-rate of a running loop', async ({ page }) => {
    test.slow(); // real tracker: synchronous MediaPipe wasm init on SwiftShader takes 10–30 s inside this test
    await gotoApp(page);
    await startCamera(page);
    // Liveness baseline taken right away (dev-server handle; no mock mode needed): the loop's frame counter
    // is measured across the whole test rather than in a tail poll that depends on leftover budget.
    const frames = () => page.evaluate(() => (window.__alterframe as unknown as { frameCount?: number } | undefined)?.frameCount ?? -1);
    const f0 = await frames();
    expect(f0, 'dev runtime handle exposes frameCount').toBeGreaterThanOrEqual(0);
    await stage(page).focus().catch(() => undefined);
    // One locator for both states (absent / shown).
    const badge = page.locator('.af-badge').filter({ hasText: /\d+\s*fps/i });
    await expect(badge, 'hidden by default').toHaveCount(0);
    await page.keyboard.press('f');
    await expect(badge, 'F shows the fps badge').toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText(/^\d+ fps$/);
    await expect(badge).toHaveAttribute('aria-label', /^\d+ frames per second$/);
    // Liveness of the loop behind the badge: the frame counter advanced since the baseline (usually already true here).
    await expect.poll(frames, { message: 'frames keep being rendered while the badge is shown' }).toBeGreaterThan(f0 + 1);
    // Mirror contract: badge text == rounded live stats, read in ONE browser-side step; the store is synced from
    // the stats at ≤ 250 ms cadence, so one sync period of lag is the only legitimate difference. A steady rate is
    // a legitimate product state, so the badge is never required to *change* within a wall-clock window.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector('.af-badge');
            const h = window.__alterframe as unknown as { getStats(): { fps: number } } | undefined;
            const shown = Number((el?.textContent ?? '').split(' ')[0]);
            return h && el ? Math.abs(shown - Math.round(h.getStats().fps)) : NaN;
          }),
        { message: 'badge mirrors the live fps within one sync period' },
      )
      .toBeLessThanOrEqual(1);
    await page.keyboard.press('f');
    await expect(badge, 'F hides the badge again').toHaveCount(0);
  });

  test('no third-party network requests after load', async ({ page }) => {
    const foreign: string[] = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (!['localhost', '127.0.0.1'].includes(u.hostname) && u.protocol.startsWith('http')) foreign.push(req.url());
    });
    await gotoApp(page);
    await startCamera(page);
    await page.waitForTimeout(3000);
    expect(foreign, 'A14: no requests leave the origin').toEqual([]);
  });
});
