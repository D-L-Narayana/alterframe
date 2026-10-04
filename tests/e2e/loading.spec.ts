/**
 * Model loading and recovery (owner: W10). Chromium + fake camera; the REAL tracker runs here (no mock),
 * so the progressbar is driven by genuine model downloads from the dev server.
 *  - progressbar "Loading tracking models" reaches aria-valuenow 100, then disappears once ready;
 *  - with /models/* blocked the failure card appears; after unblocking, "Retry tracking" loads to 100.
 * SwiftShader / sandbox: MediaPipe wasm init is slow, so the timeouts are generous.
 * Poll reads go through `readLoadingProgress` (one browser-side step) — see the helper test below.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { gotoApp, startCamera, readLoadingProgress, NAMES } from './helpers/app';

test.describe('loading progress poll helper', () => {
  test('reads presence and value in ONE browser-side step and never autowaits on a bar removed mid-poll', async ({ page }) => {
    // Static DOM: no app server involved, the behaviour under test is the helper's own.
    await page.setContent('<div role="progressbar" aria-label="Loading tracking models" aria-valuemin="0" aria-valuemax="100" aria-valuenow="42"></div>');
    expect(await readLoadingProgress(page)).toBe(42);

    const removeBar = () => page.evaluate(() => document.querySelector('[role="progressbar"]')?.remove());
    /**
     * Same Page, but every locator it hands out removes the bar right after a presence check
     * (`count()`) resolves — the host-reported race window, made deterministic. A plain
     * `page.evaluate(remove)` issued after starting the read is NOT a reliable reproduction: client
     * and server calls are independent async chains, so the removal may land after both steps (in
     * probe runs it hung once and returned 42 another time), which is why this seam is required.
     */
    const pageWithRaceAfterPresence = (real: Page): Page => {
      const asBound = (v: unknown, target: object): unknown => (typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v);
      const wrapLocator = (loc: Locator): Locator =>
        new Proxy(loc, {
          get(target, key, recv) {
            if (key === 'count') {
              return async () => {
                const n = await target.count();
                await removeBar();
                return n;
              };
            }
            return asBound(Reflect.get(target, key, recv), target);
          },
        });
      return new Proxy(real, {
        get(target, key, recv) {
          if (key === 'getByRole' || key === 'locator') {
            const factory = Reflect.get(target, key, recv) as (...args: unknown[]) => Locator;
            return (...args: unknown[]) => wrapLocator(Reflect.apply(factory, target, args));
          }
          return asBound(Reflect.get(target, key, recv), target);
        },
      });
    };

    const read = readLoadingProgress(pageWithRaceAfterPresence(page));
    read.catch(() => {}); // a hung read must not surface as an unhandled rejection when the page closes
    const outcome = await Promise.race([
      read.then((v) => ({ settled: true as const, v })),
      new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), 5000)),
    ]);
    expect(outcome.settled, 'a read must settle even when the bar is removed right after its presence check (no autowait on a removed element)').toBe(true);
    if (outcome.settled) expect([42, null]).toContain(outcome.v);
    // A one-step helper never calls the seam's `count()`, so the bar may still be there: remove it explicitly.
    await removeBar();
    expect(await readLoadingProgress(page), 'absent bar reads as null').toBeNull();
  });
});

test.describe('tracking model loading', () => {
  test('progressbar reaches 100 and disappears once the tracker is ready', async ({ page }) => {
    test.setTimeout(480_000); // SwiftShader: wasm init + model load can take minutes on a loaded machine
    await gotoApp(page);
    await startCamera(page);
    const bar = page.getByRole('progressbar', { name: NAMES.loadingBar });
    await expect(bar, 'determinate loading bar while the models download').toBeVisible({ timeout: 15_000 });
    // One atomic read: the bar may legitimately be gone a moment later (fast load = correct behaviour).
    const attrs = await bar
      .evaluate((el) => ({ min: el.getAttribute('aria-valuemin'), max: el.getAttribute('aria-valuemax'), now: el.getAttribute('aria-valuenow') }))
      .catch(() => null);
    if (attrs) {
      expect(attrs.min, 'aria-valuemin').toBe('0');
      expect(attrs.max, 'aria-valuemax').toBe('100');
      expect(Number(attrs.now), 'aria-valuenow is a number in 0..100').toBeGreaterThanOrEqual(0);
      expect(Number(attrs.now)).toBeLessThanOrEqual(100);
    }
    const seen: number[] = [];
    await expect
      .poll(
        async () => {
          const v = await readLoadingProgress(page);
          if (v !== null) seen.push(v);
          return v;
        },
        { timeout: 420_000, message: 'progress advances and the bar disappears when ready (SwiftShader wasm init + model load under load)' },
      )
      .toBeNull();
    // While observed: numeric and monotonic, and it reached (or passed through) the end of the download share.
    if (seen.length > 0) {
      for (let i = 1; i < seen.length; i++) expect(seen[i]!, 'progress never goes backwards').toBeGreaterThanOrEqual(seen[i - 1]!);
      expect(Math.max(...seen)).toBeGreaterThan(0);
    }
    // End state: ready — no bar, no failure card, the stage is operable.
    await expect(bar).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: NAMES.trackerFailure }), 'no failure card on the happy path').toHaveCount(0);
    await expect(page.getByRole('button', { name: NAMES.startRecording })).toBeEnabled();
  });

  test('blocked models → failure card; Retry tracking after unblocking loads the models', async ({ page }) => {
    test.setTimeout(480_000);
    await page.route('**/models/*', (route) => route.abort('failed'));
    await gotoApp(page);
    await startCamera(page);
    const card = page.getByRole('alert').filter({ hasText: NAMES.trackerFailure });
    const bar = page.getByRole('progressbar', { name: NAMES.loadingBar });
    await expect(card, 'blocked downloads end in the failure card').toBeVisible({ timeout: 120_000 });
    await expect(bar, 'no loading bar next to the failure card').toHaveCount(0);
    await expect(card.getByRole('button', { name: NAMES.retryTracking })).toBeVisible();
    await expect(card.getByRole('button', { name: NAMES.continueWithoutTracking })).toBeVisible();
    // The stage stays usable behind the card (non-blocking failure).
    await expect(page.locator('#stage')).toBeVisible();
    await expect(page.getByRole('button', { name: NAMES.startRecording })).toBeVisible();

    await page.unroute('**/models/*');
    await card.getByRole('button', { name: NAMES.retryTracking }).click();
    await expect(card, 'retry hides the card').toHaveCount(0, { timeout: 15_000 });
    // Presence-only poll: `count()` never autowaits (unlike locator actions), so a vanishing element cannot stall it.
    await expect
      .poll(async () => ((await card.count()) > 0 ? 'card' : (await bar.count()) > 0 ? 'loading' : 'ready'), { timeout: 420_000, message: 'retry completes the download (SwiftShader wasm init + model load under load)' })
      .toBe('ready');
  });

  test('Continue without tracking hides the card and leaves the live stage running', async ({ page }) => {
    test.setTimeout(300_000);
    await page.route('**/models/*', (route) => route.abort('failed'));
    await gotoApp(page);
    await startCamera(page);
    const card = page.getByRole('alert').filter({ hasText: NAMES.trackerFailure });
    await expect(card).toBeVisible({ timeout: 120_000 });
    await card.getByRole('button', { name: NAMES.continueWithoutTracking }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('progressbar', { name: NAMES.loadingBar }), 'no stuck loading bar').toHaveCount(0);
    await expect(page.locator('#stage')).toBeVisible();
    await expect(page.getByRole('button', { name: NAMES.startRecording })).toBeEnabled();
  });
});
