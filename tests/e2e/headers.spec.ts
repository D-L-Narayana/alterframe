/**
 * Deployment headers (owner: W10): parses vercel.json and asserts the security headers documented
 * in docs/security.md are declared for every route. Whether a server actually SENDS them is
 * covered by production-gate.spec.ts (against `npm run serve:dist` or the live deployment).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Header { key: string; value: string }
interface VercelConfig {
  cleanUrls?: boolean;
  headers?: { source: string; headers: Header[] }[];
  rewrites?: { source: string; destination: string }[];
}

const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../../vercel.json', import.meta.url)), 'utf8')) as VercelConfig;

function headersFor(source: string): Record<string, string> {
  const block = cfg.headers?.find((h) => h.source === source);
  expect(block, `headers block for ${source}`).toBeTruthy();
  return Object.fromEntries(block!.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

function csp(value: string): Record<string, string[]> {
  return Object.fromEntries(
    value
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...src] = d.split(/\s+/);
        return [name!, src];
      }),
  );
}

test('global security headers are declared', () => {
  const h = headersFor('/(.*)');
  expect(h['permissions-policy']).toMatch(/camera=\(self\)/);
  expect(h['permissions-policy']).toMatch(/microphone=\(\)/);
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['cross-origin-opener-policy']).toBe('same-origin');
  expect(h['x-frame-options'] ?? 'DENY').toBe('DENY');
  expect(h['content-security-policy']).toBeTruthy();
});

test('CSP allows exactly what the app needs (wasm, blob workers, mediastream) and nothing third-party', () => {
  const d = csp(headersFor('/(.*)')['content-security-policy']!);
  expect(d['default-src']).toEqual(["'self'"]);
  expect(d['script-src']).toEqual(expect.arrayContaining(["'self'", "'wasm-unsafe-eval'"]));
  expect(d['script-src']).not.toContain("'unsafe-eval'");
  expect(d['script-src']).not.toContain("'unsafe-inline'");
  expect(d['worker-src']).toEqual(expect.arrayContaining(["'self'", 'blob:']));
  expect(d['connect-src']).toEqual(["'self'"]);
  expect(d['img-src']).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
  expect(d['media-src']).toEqual(expect.arrayContaining(["'self'", 'blob:', 'mediastream:']));
  expect(d['font-src']).toEqual(["'self'"]);
  // 0.2 decision (docs/security.md): no 'unsafe-inline' — the production gate recorded zero
  // style-src violations with 'self' across the whole workflow.
  expect(d['style-src']).toEqual(["'self'"]);
  expect(d['object-src']).toEqual(["'none'"]);
  expect(d['base-uri']).toEqual(["'self'"]);
  expect(d['frame-ancestors']).toEqual(["'none'"]);
  for (const [name, sources] of Object.entries(d)) {
    for (const s of sources) {
      expect(s, `${name} must not reference a third-party host`).not.toMatch(/^https?:\/\//);
      expect(s, `${name} must not allow inline code`).not.toBe("'unsafe-inline'");
    }
  }
});

test('caching: immutable only for content-hashed /assets; models and wasm revalidate', () => {
  const assets = headersFor('/assets/(.*)');
  expect(assets['cache-control']).toMatch(/immutable/);
  expect(assets['cache-control']).toMatch(/max-age=31536000/);
  for (const src of ['/models/(.*)', '/wasm/(.*)']) {
    const cc = headersFor(src)['cache-control']!;
    expect(cc, `${src} is not content-hashed; must not be immutable`).not.toMatch(/immutable/);
    expect(cc).toMatch(/max-age=\d+/);
    expect(cc).toMatch(/stale-while-revalidate/);
  }
});

test('SPA rewrite and cleanUrls', () => {
  expect(cfg.cleanUrls).toBe(true);
  const spa = cfg.rewrites?.find((r) => r.destination === '/index.html');
  expect(spa, 'SPA fallback rewrite').toBeTruthy();
  // Static payload must not be rewritten to index.html.
  expect(spa!.source).toMatch(/assets|models|wasm/);
});
