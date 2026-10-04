#!/usr/bin/env node
/**
 * Production-like static server for `dist/` (owner: W10). Zero dependencies (Node built-ins only).
 *
 * Applies the deployment semantics declared in vercel.json so the production gate
 * (tests/e2e/production-gate.spec.ts) exercises the real headers and routing instead of Vite's
 * preview server:
 *   - every `headers` block whose `source` (path-to-regexp syntax, converted to a RegExp) matches
 *     the REQUEST path; later blocks override earlier ones for the same header name;
 *   - `cleanUrls` (extensionless HTML, 308 from `/x.html` to `/x`) and `trailingSlash: false`;
 *   - `rewrites` (the SPA fallback) only when no file matches — the static directories excluded
 *     by the rewrite pattern therefore 404 exactly like on Vercel;
 *   - Vercel-compatible content types (`application/wasm` so WebAssembly streams compile).
 *
 *   node scripts/serve-dist.mjs [--port 4173] [--host 127.0.0.1] [--dir dist] [--config vercel.json]
 *
 * Pure helpers are exported and unit-tested in tests/unit/infra/serve-dist.test.ts; the server
 * only starts when this file is the entry point.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cache policy Vercel applies to static files that no `headers` block covers. */
export const DEFAULT_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** Parses vercel.json (headers, rewrites, cleanUrls, trailingSlash). */
export function loadVercelConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Vercel `source` pattern (path-to-regexp) → anchored, case-insensitive RegExp.
 *  - `(...)` custom groups are copied verbatim (so `/((?!assets/|models/).*)` keeps its lookahead);
 *  - `:name` matches one path segment; `:name*` / `:name+` / `:name?` are the usual modifiers
 *    (an optional parameter takes its leading slash with it, as path-to-regexp does);
 *  - everything else is literal — a dot outside a group is a dot, not "any character".
 */
export function vercelSourceToRegExp(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      out += `\\${source[i + 1]}`;
      i += 2;
      continue;
    }
    if (ch === '(') {
      let depth = 0;
      let j = i;
      for (; j < source.length; j++) {
        const c = source[j];
        if (c === '\\') {
          j++;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j >= source.length) throw new Error(`unbalanced parentheses in source pattern: ${source}`);
      let group = source.slice(i, j + 1);
      i = j + 1;
      const mod = source[i];
      if (mod === '*' || mod === '+' || mod === '?') {
        group += mod;
        i++;
      }
      out += group;
      continue;
    }
    if (ch === ':') {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)([*+?])?/.exec(source.slice(i));
      if (m) {
        const mod = m[2];
        const optional = mod === '*' || mod === '?';
        const takesSlash = optional && out.endsWith('\\/');
        if (takesSlash) out = out.slice(0, -2);
        if (mod === '*') out += takesSlash ? '(?:\\/(.*))?' : '(.*)';
        else if (mod === '+') out += '(.+)';
        else if (mod === '?') out += takesSlash ? '(?:\\/([^\\/]+?))?' : '([^\\/]+?)?';
        else out += '([^\\/]+?)';
        i += m[0].length;
        continue;
      }
    }
    out += /[.*+?^${}|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
    i++;
  }
  return new RegExp(`^${out}\\/?$`, 'i');
}

const matcherCache = new Map();
function matcherFor(source) {
  let re = matcherCache.get(source);
  if (!re) {
    re = vercelSourceToRegExp(source);
    matcherCache.set(source, re);
  }
  return re;
}

/** Response headers for a request path: every matching block in order, later blocks winning per header name. */
export function headersFor(pathname, cfg) {
  const out = {};
  for (const block of cfg?.headers ?? []) {
    if (!matcherFor(block.source).test(pathname)) continue;
    for (const { key, value } of block.headers ?? []) {
      for (const k of Object.keys(out)) if (k.toLowerCase() === key.toLowerCase()) delete out[k];
      out[key] = value;
    }
  }
  return out;
}

/**
 * Routing decision for a request URL (query/hash ignored). `exists(rel)` must be true only for
 * regular files below the served directory. Filesystem first, then `rewrites`, then 404 — the
 * order Vercel uses for static deployments.
 */
export function resolveRequest(rawUrl, cfg, exists) {
  const cut = rawUrl.search(/[?#]/);
  const raw = cut === -1 ? rawUrl : rawUrl.slice(0, cut);
  let pathname;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    return { kind: 'badrequest', status: 400, pathname: raw };
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.includes('\0') || pathname.split('/').some((seg) => seg === '..' || seg === '.')) {
    return { kind: 'badrequest', status: 400, pathname };
  }
  const cleanUrls = cfg?.cleanUrls === true;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const stripped = pathname.replace(/\/+$/, '') || '/';
    if (cfg?.trailingSlash === false) return { kind: 'redirect', status: 308, location: stripped, pathname };
    pathname = stripped;
  }
  const rel = pathname === '/' ? '' : pathname.slice(1);
  if (cleanUrls && /\.html$/i.test(rel)) {
    const clean = rel.replace(/(^|\/)index\.html$/i, '$1').replace(/\.html$/i, '').replace(/\/$/, '');
    return { kind: 'redirect', status: 308, location: `/${clean}`, pathname };
  }
  const candidates = rel === '' ? ['index.html'] : [rel, ...(cleanUrls ? [`${rel}.html`] : []), `${rel}/index.html`];
  for (const file of candidates) if (exists(file)) return { kind: 'file', status: 200, file, pathname, rewritten: false };
  for (const rw of cfg?.rewrites ?? []) {
    if (!matcherFor(rw.source).test(pathname)) continue;
    const dest = (rw.destination ?? '').replace(/^\//, '').split(/[?#]/)[0];
    if (dest && exists(dest)) return { kind: 'file', status: 200, file: dest, pathname, rewritten: true };
  }
  return { kind: 'notfound', status: 404, pathname };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Content type by extension; unknown types are served as opaque bytes (never sniffed: nosniff is set). */
export function contentTypeFor(file) {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** CLI flags: --port N, --host H, --dir D, --config F (also `--flag=value`). */
export function parseArgs(argv) {
  const args = { port: 4173, host: '127.0.0.1', dir: 'dist', config: 'vercel.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const next = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    switch (key) {
      case '--port': {
        const v = Number(next());
        if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error('--port expects an integer between 0 and 65535');
        args.port = v;
        break;
      }
      case '--host':
        args.host = String(next());
        break;
      case '--dir':
        args.dir = String(next());
        break;
      case '--config':
        args.config = String(next());
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function sendText(res, status, body) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  res.writeHead(status);
  res.end(body);
}

/**
 * Starts the server. `port: 0` picks a free port. Resolves with the URL and a `close()` that
 * terminates open keep-alive connections so test runners exit promptly.
 */
export function startServer({ dir, host = '127.0.0.1', port = 0, config = null, log = () => {} }) {
  const root = resolve(dir);
  const cfg = config ?? {};
  const exists = (rel) => {
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) return false;
    try {
      return statSync(abs).isFile();
    } catch {
      return false;
    }
  };
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const r = resolveRequest(req.url ?? '/', cfg, exists);
    for (const [k, v] of Object.entries(headersFor(r.pathname, cfg))) res.setHeader(k, v);
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendText(res, 405, 'Method not allowed');
      return;
    }
    if (r.kind === 'redirect') {
      res.setHeader('Location', r.location);
      sendText(res, 308, `Redirecting to ${r.location}`);
      return;
    }
    if (r.kind === 'badrequest') {
      sendText(res, 400, 'Bad request');
      return;
    }
    if (r.kind === 'notfound') {
      log(`${method} ${r.pathname} → 404`);
      sendText(res, 404, 'Not found');
      return;
    }
    const abs = resolve(root, r.file);
    const st = statSync(abs);
    // Platform default for static files when no header block set a cache policy (what Vercel sends).
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', DEFAULT_CACHE_CONTROL);
    res.setHeader('Content-Type', contentTypeFor(r.file));
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    res.writeHead(200);
    if (method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(abs)
      .on('error', () => res.destroy())
      .pipe(res);
    log(`${method} ${r.pathname} → ${r.file}${r.rewritten ? ' (rewrite)' : ''}`);
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const hostForUrl = host.includes(':') ? `[${host}]` : host;
      resolveStart({
        url: `http://${hostForUrl}:${actualPort}`,
        port: actualPort,
        close: () =>
          new Promise((done) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[serve-dist] ${err instanceof Error ? err.message : String(err)}`);
    console.error('usage: node scripts/serve-dist.mjs [--port 4173] [--host 127.0.0.1] [--dir dist] [--config vercel.json]');
    process.exit(2);
  }
  if (!existsSync(resolve(args.dir, 'index.html'))) {
    console.error(`[serve-dist] ${args.dir}/index.html not found — run \`npm run build\` first`);
    process.exit(1);
  }
  const configPath = resolve(args.config);
  const config = existsSync(configPath) ? loadVercelConfig(configPath) : null;
  if (!config) console.warn(`[serve-dist] ${args.config} not found — serving plain static files without deployment headers`);
  const { url, close } = await startServer({ dir: args.dir, host: args.host, port: args.port, config });
  console.log(`[serve-dist] serving ${args.dir}/ at ${url} (${config ? `headers, rewrites and cleanUrls from ${args.config}` : 'no deployment config'})`);
  const shutdown = () => {
    close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
