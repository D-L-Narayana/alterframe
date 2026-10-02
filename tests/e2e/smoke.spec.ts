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

  test('fps badge appears via the F shortcut and updates', async ({ page }) => {
    await gotoApp(page);
    await startCamera(page);
    await stage(page).focus().catch(() => undefined);
    await page.keyboard.press('f');
    const badge = page.getByText(/\d+\s*fps/i).first();
    await expect(badge, 'fps badge (contract §W1.7, toggled with F)').toBeVisible({ timeout: 15_000 });
    const first = await badge.textContent();
    await expect.poll(async () => badge.textContent(), { timeout: 10_000 }).not.toBe(first);
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
