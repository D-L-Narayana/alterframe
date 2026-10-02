/**
 * Production gate (owner: W10): a PRODUCTION build must not expose the test hooks even with
 * `?mockTracking=1`. Runs only when E2E_PROD_URL points at `vite preview` of a plain `npm run build`
 * (no VITE_E2E=1). The lead runs this before release; skipped otherwise.
 */
import { test, expect } from '@playwright/test';

const prod = process.env.E2E_PROD_URL;

test.describe('production build', () => {
  test.skip(!prod, 'set E2E_PROD_URL=http://127.0.0.1:4173 after `npm run build && npm run preview`');

  test('no window.__alterframe / injectTracking with ?mockTracking=1', async ({ page }) => {
    await page.goto(`${prod}/?mockTracking=1`);
    await page.getByRole('button', { name: /use camera/i }).click();
    await expect(page.locator('#stage')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    const exposed = await page.evaluate(() => ({
      handle: typeof window.__alterframe !== 'undefined',
      inject: typeof window.__alterframe?.injectTracking === 'function',
    }));
    expect(exposed, 'dev-only hooks leaked into production').toEqual({ handle: false, inject: false });
  });

  test('no inline scripts (CSP script-src self)', async ({ page }) => {
    await page.goto(`${prod}/`);
    const inline = await page.evaluate(() => Array.from(document.scripts).filter((s) => !s.src).length);
    expect(inline).toBe(0);
  });
});
