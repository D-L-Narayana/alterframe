/**
 * Production gate (owner: W10). Runs only when `E2E_PROD_URL` points at a server that serves a plain
 * `npm run build` WITH the deployment semantics — `npm run serve:dist` (scripts/serve-dist.mjs applies
 * vercel.json headers/rewrites) or the live deployment:
 *
 *   npm run build && node scripts/with-server.mjs -- npm run test:prod-gate
 *   E2E_PROD_URL=https://<host> npx playwright test tests/e2e/production-gate.spec.ts
 *
 * Proves: no dev/e2e hooks even with `?mockTracking=1`; no inline scripts; ZERO Content-Security-Policy
 * violations across onboarding → camera → stage → settings → a 1 s recording (with the tracking
 * runtime — wasm + models — fully loaded); and the live response headers equal vercel.json.
 * Chromium here runs the fake camera + SwiftShader, so this is a wiring/policy gate, not a
 * real-camera claim.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const prod = process.env.E2E_PROD_URL?.replace(/\/+$/, '');

interface Header { key: string; value: string }
interface VercelConfig { headers?: { source: string; headers: Header[] }[] }
const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../../vercel.json', import.meta.url)), 'utf8')) as VercelConfig;
/** Lower-cased header map declared in vercel.json for a `source` pattern. */
function declared(source: string): Record<string, string> {
  const block = cfg.headers?.find((b) => b.source === source);
  expect(block, `vercel.json headers block ${source}`).toBeTruthy();
  return Object.fromEntries(block!.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

interface CspViolation { directive: string; blocked: string; source: string; line: number; sample: string }
declare global {
  interface Window { __cspViolations?: CspViolation[] }
}

/**
 * Collects CSP violations from two channels: `securitypolicyviolation` events on the document
 * (registered before any app script runs) and console messages mentioning the policy (Chromium
 * reports refusals from workers and inline-style attempts on the page console as well).
 */
async function captureCspViolations(page: Page): Promise<() => Promise<CspViolation[]>> {
  const consoleHits: string[] = [];
  const onConsole = (text: string): void => {
    if (/Content[- ]Security[- ]Policy|Refused to (load|apply|execute|connect|compile)/i.test(text)) consoleHits.push(text);
  };
  page.on('console', (m) => onConsole(m.text()));
  await page.addInitScript(() => {
    const list: CspViolation[] = [];
    window.__cspViolations = list;
    document.addEventListener('securitypolicyviolation', (e) => {
      list.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample });
    });
  });
  return async () => {
    const inPage = page.isClosed() ? [] : await page.evaluate(() => window.__cspViolations ?? []);
    return [...inPage, ...consoleHits.map((text) => ({ directive: 'console', blocked: '', source: '', line: 0, sample: text }))];
  };
}

test.describe('production build', () => {
  test.skip(!prod, 'set E2E_PROD_URL (e.g. `npm run build && node scripts/with-server.mjs -- npm run test:prod-gate`)');

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

  test('zero CSP violations and no third-party requests: onboarding → camera → stage → settings → 1 s recording, tracking runtime loaded, then 65 s idle', async ({ page }) => {
    test.setTimeout(600_000); // real MediaPipe wasm init + model download on SwiftShader, plus the idle period
    const violations = await captureCspViolations(page);
    const ownHost = new URL(`${prod}/`).host;
    const foreign = new Set<string>();
    const noteRequest = (url: string): void => {
      try {
        const u = new URL(url);
        if (u.protocol.startsWith('http') && u.host !== ownHost) foreign.add(url);
      } catch {
        /* data: / blob: URLs */
      }
    };
    page.on('request', (r) => noteRequest(r.url()));
    page.on('requestfailed', (r) => noteRequest(r.url()));
    await page.goto(`${prod}/`);
    await page.getByRole('button', { name: /use camera/i }).click();
    await expect(page.locator('#stage')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.keyboard.press('r');
    await expect(page.getByRole('button', { name: 'Stop recording' }), 'recording started with R').toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('r');
    expect((await download).suggestedFilename()).toMatch(/^alterframe-\d{8}-\d{6}\.(webm|mp4)$/);

    // Let the tracking runtime settle (wasm compiled, models loaded or a reported failure) so any
    // wasm/worker/connect violation would have surfaced by now.
    const progress = page.getByRole('progressbar', { name: 'Loading tracking models' });
    const failure = page.getByRole('alert').filter({ hasText: 'Tracking models could not be loaded' });
    // Presence-only poll: `count()` never autowaits (unlike locator actions), so a vanishing bar cannot stall it.
    await expect
      .poll(async () => ((await progress.count()) === 0 ? 'settled' : (await failure.count()) > 0 ? 'failed' : 'loading'), {
        timeout: 180_000,
        message: 'tracking initialisation settles (ready or reported failure)',
      })
      .not.toBe('loading');
    // One browser-side read (no count()-then-action race): the card may come or go between two calls.
    const failureText = await failure.evaluateAll((els) => els[0]?.textContent ?? null);
    test.info().annotations.push({ type: 'tracker', description: failureText !== null ? `failure card shown: ${failureText}` : 'ready (progressbar gone)' });

    // Background timers in dependencies fire on minute-scale intervals (a periodic flush is the
    // classic shape of a telemetry client). Keep the fully loaded app alive past one such interval
    // so a request to another origin surfaces deterministically instead of only on long runs.
    await page.waitForTimeout(65_000);

    const found = await violations();
    expect(found, `Content-Security-Policy violations:\n${JSON.stringify(found, null, 2)}`).toEqual([]);
    expect([...foreign], 'requests to other origins (privacy: nothing leaves the device)').toEqual([]);
  });

  test('live response headers equal vercel.json on /, the entry asset, a model and the wasm runtime', async ({ request }) => {
    const global = declared('/(.*)');
    const root = await request.get(`${prod}/`);
    expect(root.status()).toBe(200);
    const h = root.headers();
    expect(h['content-type']).toMatch(/text\/html/);
    expect(h['content-security-policy'], 'CSP served exactly as declared').toBe(global['content-security-policy']);
    expect(h['permissions-policy']).toBe(global['permissions-policy']);
    expect(h['referrer-policy']).toBe(global['referrer-policy']);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
    expect(h['cache-control'] ?? '', 'the document must stay revalidated, never immutable').not.toMatch(/immutable/);

    const html = await root.text();
    const entry = /<script\b[^>]*\bsrc="([^"]+\.js)"/.exec(html)?.[1];
    expect(entry, 'index.html references the entry script').toBeTruthy();
    const asset = await request.get(new URL(entry!, `${prod}/`).href);
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-type']).toMatch(/javascript/);
    expect(asset.headers()['content-security-policy']).toBe(global['content-security-policy']);
    expect(asset.headers()['cache-control']).toBe(declared('/assets/(.*)')['cache-control']);
    expect(asset.headers()['cache-control']).toMatch(/immutable/);

    for (const [path, source] of [
      ['/models/hand_landmarker.task', '/models/(.*)'],
      ['/wasm/vision_wasm_internal.wasm', '/wasm/(.*)'],
    ] as const) {
      const res = await request.head(`${prod}${path}`);
      expect(res.status(), `${path} is served`).toBe(200);
      const cc = res.headers()['cache-control'] ?? '';
      expect(cc, `${path} cache policy`).toBe(declared(source)['cache-control']);
      expect(cc).toMatch(/stale-while-revalidate/);
      expect(cc).not.toMatch(/immutable/);
      expect(res.headers()['x-content-type-options']).toBe('nosniff');
    }
    const wasm = await request.head(`${prod}/wasm/vision_wasm_internal.wasm`);
    expect(wasm.headers()['content-type'], 'wasm must be application/wasm for streaming compilation').toMatch(/^application\/wasm/);
  });
});
