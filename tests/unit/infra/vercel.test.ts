/** vercel.json structure (owner: W10). Header semantics are covered by tests/e2e/headers.spec.ts too. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from './paths';

interface Header { key: string; value: string }
interface VercelConfig {
  cleanUrls?: boolean;
  framework?: string;
  outputDirectory?: string;
  buildCommand?: string;
  installCommand?: string;
  headers?: { source: string; headers: Header[] }[];
  rewrites?: { source: string; destination: string }[];
}
const cfg = JSON.parse(readFileSync(join(APP_ROOT, 'vercel.json'), 'utf8')) as VercelConfig;
const h = (source: string): Record<string, string> => Object.fromEntries((cfg.headers?.find((b) => b.source === source)?.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));

describe('vercel.json', () => {
  it('builds with npm ci + npm run build into dist', () => {
    expect(cfg.framework).toBe('vite');
    expect(cfg.outputDirectory).toBe('dist');
    expect(cfg.buildCommand).toBe('npm run build');
    expect(cfg.installCommand).toBe('npm ci');
    expect(cfg.cleanUrls).toBe(true);
  });

  it('declares every plan §4 security header on all routes', () => {
    const g = h('/(.*)');
    expect(g['content-security-policy']).toContain("default-src 'self'");
    expect(g['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(g['content-security-policy']).toContain("worker-src 'self' blob:");
    expect(g['content-security-policy']).toContain("media-src 'self' blob: mediastream:");
    expect(g['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(g['permissions-policy']).toContain('camera=(self)');
    expect(g['permissions-policy']).toContain('microphone=()');
    expect(g['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(g['x-content-type-options']).toBe('nosniff');
    expect(g['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('CSP has no third-party hosts, no unsafe-eval (wasm-unsafe-eval only) and no unsafe-inline anywhere', () => {
    const csp = h('/(.*)')['content-security-policy']!;
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).not.toMatch(/'unsafe-eval'/);
    // Decision 0.2 (docs/security.md): the built app needs no inline styles — React writes styles
    // through the CSSOM and the font faces live in the bundled stylesheet — so style-src is 'self'.
    expect(csp).toContain("style-src 'self';");
    expect(csp).not.toMatch(/'unsafe-inline'/);
  });

  it('immutable caching is restricted to content-hashed /assets', () => {
    for (const block of cfg.headers ?? []) {
      const cc = block.headers.find((x) => x.key.toLowerCase() === 'cache-control')?.value;
      if (cc?.includes('immutable')) expect(block.source, `immutable cache on ${block.source}`).toBe('/assets/(.*)');
    }
    expect(h('/models/(.*)')['cache-control']).toMatch(/stale-while-revalidate/);
    expect(h('/wasm/(.*)')['cache-control']).toMatch(/stale-while-revalidate/);
  });

  it('SPA rewrite excludes static payload directories', () => {
    const spa = cfg.rewrites?.find((r) => r.destination === '/index.html');
    expect(spa).toBeTruthy();
    const re = new RegExp(`^${spa!.source.replace(/\\\\/g, '\\')}$`);
    expect(re.test('/')).toBe(true);
    expect(re.test('/anything')).toBe(true);
    expect(re.test('/models/hand_landmarker.task')).toBe(false);
    expect(re.test('/wasm/vision_wasm_internal.wasm')).toBe(false);
    expect(re.test('/assets/index-abc123.js')).toBe(false);
    expect(re.test('/favicon.svg')).toBe(false);
    expect(re.test('/manifest.webmanifest')).toBe(false);
  });
});
