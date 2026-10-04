/**
 * serve-dist (owner: W10): the zero-dependency static server used by the production gate must apply
 * the SAME semantics as vercel.json — header blocks by `source` pattern, `cleanUrls`, the SPA rewrite
 * with its static exclusions, Vercel-compatible content types — so a green gate against it says
 * something about the deployment. Pure helpers are tested directly; one round trip exercises the
 * HTTP server against a temporary dist folder with the real vercel.json.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ROOT } from './paths';
import {
  DEFAULT_CACHE_CONTROL,
  vercelSourceToRegExp,
  headersFor,
  resolveRequest,
  contentTypeFor,
  parseArgs,
  loadVercelConfig,
  startServer,
  type VercelConfig,
} from '../../../scripts/serve-dist.mjs';

const cfg = loadVercelConfig(join(APP_ROOT, 'vercel.json'));
const spaSource = cfg.rewrites!.find((r) => r.destination === '/index.html')!.source;

describe('vercelSourceToRegExp', () => {
  it('converts the catch-all and prefix patterns', () => {
    const all = vercelSourceToRegExp('/(.*)');
    expect(all.test('/')).toBe(true);
    expect(all.test('/index.html')).toBe(true);
    expect(all.test('/assets/index-abc.js')).toBe(true);
    const assets = vercelSourceToRegExp('/assets/(.*)');
    expect(assets.test('/assets/index-abc.js')).toBe(true);
    expect(assets.test('/assets/fonts/inter.woff2')).toBe(true);
    expect(assets.test('/models/hand_landmarker.task')).toBe(false);
    expect(assets.test('/')).toBe(false);
  });

  it('treats dots outside groups as literals (path-to-regexp semantics)', () => {
    const idx = vercelSourceToRegExp('/index.html');
    expect(idx.test('/index.html')).toBe(true);
    expect(idx.test('/indexXhtml')).toBe(false);
    expect(idx.test('/index.html/extra')).toBe(false);
  });

  it('supports :named parameters (single segment) and :splat* (rest)', () => {
    const one = vercelSourceToRegExp('/blog/:slug');
    expect(one.test('/blog/hello')).toBe(true);
    expect(one.test('/blog/hello/world')).toBe(false);
    const rest = vercelSourceToRegExp('/files/:path*');
    expect(rest.test('/files/a/b/c.txt')).toBe(true);
  });

  it('the SPA rewrite source from vercel.json excludes every static payload path', () => {
    const re = vercelSourceToRegExp(spaSource);
    expect(re.test('/')).toBe(true);
    expect(re.test('/anything')).toBe(true);
    expect(re.test('/deep/route')).toBe(true);
    for (const excluded of ['/assets/index-abc.js', '/models/hand_landmarker.task', '/wasm/vision_wasm_internal.wasm', '/icons/icon.svg', '/favicon.svg', '/manifest.webmanifest', '/robots.txt']) {
      expect(re.test(excluded), `${excluded} must not be rewritten to index.html`).toBe(false);
    }
  });
});

describe('headersFor', () => {
  it('applies every matching block; the global block reaches all routes', () => {
    const root = headersFor('/', cfg);
    expect(root['Content-Security-Policy']).toBe(cfg.headers!.find((b) => b.source === '/(.*)')!.headers.find((h) => h.key === 'Content-Security-Policy')!.value);
    expect(root['Permissions-Policy']).toMatch(/camera=\(self\)/);
    expect(root['X-Frame-Options']).toBe('DENY');
    expect(root['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(root['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(root['X-Content-Type-Options']).toBe('nosniff');
    expect(root['Cache-Control']).toBeUndefined();

    const asset = headersFor('/assets/index-abc.js', cfg);
    expect(asset['Content-Security-Policy']).toBe(root['Content-Security-Policy']);
    expect(asset['Cache-Control']).toBe('public, max-age=31536000, immutable');

    expect(headersFor('/models/hand_landmarker.task', cfg)['Cache-Control']).toMatch(/stale-while-revalidate/);
    expect(headersFor('/wasm/vision_wasm_internal.wasm', cfg)['Cache-Control']).toMatch(/stale-while-revalidate/);
    expect(headersFor('/wasm/vision_wasm_internal.wasm', cfg)['Cache-Control']).not.toMatch(/immutable/);
  });

  it('later blocks override earlier ones for the same key (case-insensitively), like Vercel', () => {
    const synthetic: VercelConfig = {
      headers: [
        { source: '/(.*)', headers: [{ key: 'cache-control', value: 'a' }, { key: 'X-Test', value: '1' }] },
        { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'b' }] },
      ],
    };
    const h = headersFor('/assets/x.js', synthetic);
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'cache-control')).toHaveLength(1);
    expect(h['Cache-Control'] ?? h['cache-control']).toBe('b');
    expect(h['X-Test']).toBe('1');
    expect(headersFor('/', synthetic)['cache-control']).toBe('a');
  });
});

describe('resolveRequest (cleanUrls, trailingSlash: false, SPA rewrite)', () => {
  const files = new Set(['index.html', 'about.html', 'assets/index-abc.js', 'models/hand_landmarker.task', 'icons/icon.svg', 'favicon.svg', 'docs/index.html']);
  const exists = (rel: string) => files.has(rel);

  it('serves index.html for the root and existing files directly', () => {
    expect(resolveRequest('/', cfg, exists)).toMatchObject({ kind: 'file', file: 'index.html', status: 200, rewritten: false });
    expect(resolveRequest('/assets/index-abc.js', cfg, exists)).toMatchObject({ kind: 'file', file: 'assets/index-abc.js', status: 200 });
    expect(resolveRequest('/icons/icon.svg', cfg, exists)).toMatchObject({ kind: 'file', file: 'icons/icon.svg' });
    expect(resolveRequest('/favicon.svg', cfg, exists)).toMatchObject({ kind: 'file', file: 'favicon.svg' });
  });

  it('strips query strings and hashes before resolving', () => {
    expect(resolveRequest('/?mockTracking=1', cfg, exists)).toMatchObject({ kind: 'file', file: 'index.html', pathname: '/' });
    expect(resolveRequest('/assets/index-abc.js?v=2', cfg, exists)).toMatchObject({ kind: 'file', file: 'assets/index-abc.js' });
  });

  it('cleanUrls: extensionless paths serve the .html; .html requests redirect (308) to the clean URL', () => {
    expect(resolveRequest('/about', cfg, exists)).toMatchObject({ kind: 'file', file: 'about.html', status: 200 });
    expect(resolveRequest('/about.html', cfg, exists)).toMatchObject({ kind: 'redirect', status: 308, location: '/about' });
    expect(resolveRequest('/index.html', cfg, exists)).toMatchObject({ kind: 'redirect', status: 308, location: '/' });
    expect(resolveRequest('/docs', cfg, exists)).toMatchObject({ kind: 'file', file: 'docs/index.html' });
  });

  it('trailingSlash: false redirects directory-style URLs (except the root)', () => {
    expect(resolveRequest('/about/', cfg, exists)).toMatchObject({ kind: 'redirect', status: 308, location: '/about' });
    expect(resolveRequest('/', cfg, exists)).toMatchObject({ kind: 'file' });
  });

  it('unknown app routes are rewritten to index.html; static directories are NOT (404)', () => {
    expect(resolveRequest('/deep/route', cfg, exists)).toMatchObject({ kind: 'file', file: 'index.html', status: 200, rewritten: true, pathname: '/deep/route' });
    expect(resolveRequest('/assets/missing.js', cfg, exists)).toMatchObject({ kind: 'notfound', status: 404 });
    expect(resolveRequest('/models/missing.task', cfg, exists)).toMatchObject({ kind: 'notfound', status: 404 });
    expect(resolveRequest('/wasm/nope.wasm', cfg, exists)).toMatchObject({ kind: 'notfound', status: 404 });
    expect(resolveRequest('/icons/nope.svg', cfg, exists)).toMatchObject({ kind: 'notfound', status: 404 });
  });

  it('never escapes the dist folder and rejects malformed encodings', () => {
    const r = resolveRequest('/../package.json', cfg, exists);
    expect(r.kind === 'file' ? r.file : '').not.toMatch(/\.\./);
    expect(resolveRequest('/assets/%2e%2e/%2e%2e/package.json', cfg, exists).kind).not.toBe('file');
    expect(resolveRequest('/%E0%A4%A', cfg, exists)).toMatchObject({ kind: 'badrequest', status: 400 });
  });

  it('without a config falls back to plain static serving (no rewrites)', () => {
    expect(resolveRequest('/deep/route', {}, exists)).toMatchObject({ kind: 'notfound' });
    expect(resolveRequest('/about.html', {}, exists)).toMatchObject({ kind: 'file', file: 'about.html' });
  });
});

describe('contentTypeFor', () => {
  it('maps every payload extension; wasm is application/wasm (needed for streaming compile)', () => {
    expect(contentTypeFor('index.html')).toMatch(/^text\/html; charset=utf-8$/);
    expect(contentTypeFor('assets/index-abc.js')).toMatch(/^text\/javascript/);
    expect(contentTypeFor('x.mjs')).toMatch(/^text\/javascript/);
    expect(contentTypeFor('assets/index.css')).toMatch(/^text\/css/);
    expect(contentTypeFor('assets/inter.woff2')).toBe('font/woff2');
    expect(contentTypeFor('assets/inter.woff')).toBe('font/woff');
    expect(contentTypeFor('favicon.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('manifest.webmanifest')).toMatch(/^application\/manifest\+json/);
    expect(contentTypeFor('hands.schedule.json')).toMatch(/^application\/json/);
    expect(contentTypeFor('assets/index.js.map')).toMatch(/^application\/json/);
    expect(contentTypeFor('wasm/vision_wasm_internal.wasm')).toBe('application/wasm');
    expect(contentTypeFor('models/hand_landmarker.task')).toBe('application/octet-stream');
    expect(contentTypeFor('models/selfie_segmenter.tflite')).toBe('application/octet-stream');
    expect(contentTypeFor('robots.txt')).toMatch(/^text\/plain/);
    expect(contentTypeFor('something.unknownext')).toBe('application/octet-stream');
  });
});

describe('parseArgs', () => {
  it('defaults to 127.0.0.1:4173 serving ./dist with ./vercel.json', () => {
    expect(parseArgs([])).toEqual({ port: 4173, host: '127.0.0.1', dir: 'dist', config: 'vercel.json' });
  });
  it('accepts --port, --dir, --host, --config', () => {
    expect(parseArgs(['--port', '4199', '--dir', 'out', '--host', '0.0.0.0', '--config', 'cfg.json'])).toEqual({ port: 4199, host: '0.0.0.0', dir: 'out', config: 'cfg.json' });
  });
  it('rejects a non-numeric port', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/port/);
  });
});

describe('HTTP round trip (temporary dist + real vercel.json)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alterframe-serve-dist-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'models'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title><div id="root"></div>');
  writeFileSync(join(dir, 'about.html'), '<!doctype html><title>about</title>');
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'console.log(1);');
  writeFileSync(join(dir, 'models', 'm.task'), Buffer.from([1, 2, 3, 4]));
  let close: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves documents, assets, redirects, rewrites and 404s with the vercel.json headers', async () => {
    const started = await startServer({ dir, host: '127.0.0.1', port: 0, config: cfg });
    close = started.close;
    const base = started.url;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toMatch(/^text\/html/);
    expect(root.headers.get('content-security-policy')).toBe(headersFor('/', cfg)['Content-Security-Policy']);
    expect(root.headers.get('x-frame-options')).toBe('DENY');
    expect(root.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    // Header blocks match the REQUEST path (Vercel semantics): the `/index.html` block does not
    // apply to `/` (which gets the platform default), and `/index.html` itself redirects under
    // cleanUrls (see docs/release.md).
    expect(root.headers.get('cache-control')).toBe(DEFAULT_CACHE_CONTROL);
    expect(await root.text()).toContain('id="root"');
    const idx = await fetch(`${base}/index.html`, { redirect: 'manual' });
    expect(idx.status).toBe(308);
    expect(idx.headers.get('location')).toBe('/');
    expect(idx.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');

    const asset = await fetch(`${base}/assets/app-abc.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-security-policy')).toBeTruthy();

    const model = await fetch(`${base}/models/m.task`);
    expect(model.status).toBe(200);
    expect(model.headers.get('content-type')).toBe('application/octet-stream');
    expect(model.headers.get('content-length')).toBe('4');
    expect(model.headers.get('cache-control')).toMatch(/stale-while-revalidate/);
    expect(model.headers.get('cache-control'), 'a declared block wins over the platform default').not.toBe(DEFAULT_CACHE_CONTROL);

    expect((await fetch(`${base}/assets/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/models/nope.task`)).status).toBe(404);

    const spa = await fetch(`${base}/deep/route?x=1`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('id="root"');

    const redirect = await fetch(`${base}/about.html`, { redirect: 'manual' });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('/about');
    const clean = await fetch(`${base}/about`);
    expect(clean.status).toBe(200);
    expect(await clean.text()).toContain('about');

    const head = await fetch(`${base}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength('<!doctype html><title>t</title><div id="root"></div>')));
    expect(await head.text()).toBe('');

    const post = await fetch(`${base}/`, { method: 'POST' });
    expect(post.status).toBe(405);
  });
});
