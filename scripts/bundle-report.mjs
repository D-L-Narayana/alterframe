#!/usr/bin/env node
/**
 * Bundle size report (owner: W10). Zero dependencies.
 *
 *   node scripts/bundle-report.mjs [--strict] [--dir dist]
 *
 * Prints a per-chunk table (raw / gzip, decimal kB like Vite) of dist/assets/*.js|css and enforces:
 *   - total JS gzip ≤ BUNDLE_BUDGET_JS_GZ (default 450 kB = 450 000 B)       → always a hard failure;
 *   - entry-chunk gzip ≤ BUNDLE_BUDGET_ENTRY_GZ (default 128 kB = 128 000 B)  → warning, failure with --strict;
 *   - no MediaPipe (`@mediapipe` / `tasks-vision` / `mediapipe.tasks.vision`, or a sourcemap source
 *     under node_modules/@mediapipe) in any ENTRY chunk — the chunks dist/index.html loads up-front
 *     (module scripts + modulepreload) → prints "entry-chunk MediaPipe check: OK|WARN|FAIL";
 *     WARN by default, FAIL with --strict (CI runs --strict: tracking is a lazy chunk).
 * Pure helpers are exported for tests/unit/infra/bundle-report.test.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Sizes are decimal kilobytes (1 kB = 1000 B), the unit Vite's build output uses.
export const DEFAULT_BUDGET_JS_GZ = 450_000;
/**
 * Entry chunk (everything index.html loads before the first interaction, MediaPipe excluded):
 * measured 125.1 kB gz on the v0.2 build by Vite's build output (this report's own gzip of the same
 * file prints 124.0 kB — a different zlib level); react-dom ≈ 53 % of the entry; 128 kB = measured
 * + ≈ 2 % headroom, so growth stays deliberate; raise it here (with the new measurement) rather than silently.
 */
export const DEFAULT_BUDGET_ENTRY_GZ = 128_000;

/** JS chunk file names (basename) that the document loads before any user interaction. */
export function entryChunksOf(html) {
  const out = [];
  const add = (url) => {
    if (!url || /^[a-z]+:\/\//i.test(url)) return;
    const name = url.split(/[?#]/)[0].split('/').pop();
    if (name && /\.m?js$/i.test(name) && !out.includes(name)) out.push(name);
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']modulepreload["'][^>]*>/gi)) add(m[1]);
  return out;
}

const CODE_MARKERS = ['@mediapipe', 'tasks-vision', 'mediapipe.tasks.vision'];

/** Human-readable reasons a chunk is considered to contain MediaPipe (empty = clean). */
export function mediaPipeMarkers(code, sources) {
  const hits = [];
  for (const marker of CODE_MARKERS) if (code.includes(marker)) hits.push(`code: ${marker}`);
  if (sources.some((s) => /node_modules\/@mediapipe\/tasks-vision\//.test(s))) hits.push('sourcemap: node_modules/@mediapipe/tasks-vision');
  return hits;
}

/** Budget policy; see the file header. */
export function evaluateBudgets({ totalJsGz, entryGz, budgets, mediaPipeHits }, strict) {
  const failures = [];
  const warnings = [];
  if (totalJsGz > budgets.totalJsGz) failures.push(`total JS gzip ${fmtKb(totalJsGz)} exceeds the budget of ${fmtKb(budgets.totalJsGz)}`);
  if (entryGz > budgets.entryGz) {
    const msg = `entry chunk gzip ${fmtKb(entryGz)} exceeds the budget of ${fmtKb(budgets.entryGz)}`;
    (strict ? failures : warnings).push(msg);
  }
  let mediaPipeStatus = 'OK';
  if (mediaPipeHits.length > 0) {
    const msg = `MediaPipe code is bundled into an entry chunk (must be a lazily imported chunk): ${mediaPipeHits.join('; ')}`;
    if (strict) {
      failures.push(msg);
      mediaPipeStatus = 'FAIL';
    } else {
      warnings.push(msg);
      mediaPipeStatus = 'WARN';
    }
  }
  return { failures, warnings, mediaPipeStatus };
}

export function parseFlags(argv) {
  const flags = { strict: false, dir: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') flags.strict = true;
    else if (a === '--dir') flags.dir = String(argv[++i]);
    else if (a.startsWith('--dir=')) flags.dir = a.slice('--dir='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return flags;
}

export function fmtKb(bytes) {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

function sourcesOfMap(mapPath) {
  if (!existsSync(mapPath)) return [];
  try {
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    return Array.isArray(map.sources) ? map.sources.map(String) : [];
  } catch {
    return [];
  }
}

function main(argv) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    console.error(`[bundle] ${err instanceof Error ? err.message : String(err)}`);
    console.error('usage: node scripts/bundle-report.mjs [--strict] [--dir dist]');
    return 2;
  }
  const dist = resolve(process.cwd(), flags.dir);
  const assets = resolve(dist, 'assets');
  const indexPath = resolve(dist, 'index.html');
  if (!existsSync(assets) || !existsSync(indexPath)) {
    console.error(`[bundle] ${flags.dir}/index.html or ${flags.dir}/assets missing — run \`npm run build\` first`);
    return 1;
  }
  const budgets = {
    totalJsGz: Number(process.env.BUNDLE_BUDGET_JS_GZ ?? DEFAULT_BUDGET_JS_GZ),
    entryGz: Number(process.env.BUNDLE_BUDGET_ENTRY_GZ ?? DEFAULT_BUDGET_ENTRY_GZ),
  };
  const entries = entryChunksOf(readFileSync(indexPath, 'utf8'));
  let totalJs = 0;
  let entryGz = 0;
  const mediaPipeHits = [];
  const rows = [];
  for (const f of readdirSync(assets).sort()) {
    if (!/\.(m?js|css)$/.test(f)) continue;
    const buf = readFileSync(resolve(assets, f));
    const raw = statSync(resolve(assets, f)).size;
    const gz = gzipSync(buf).length;
    const isJs = /\.m?js$/.test(f);
    const isEntry = entries.includes(f);
    let mediaPipe = '';
    if (isJs) {
      totalJs += gz;
      const hits = mediaPipeMarkers(buf.toString('utf8'), sourcesOfMap(resolve(assets, `${f}.map`)));
      mediaPipe = hits.length ? 'yes' : '';
      if (isEntry) {
        entryGz += gz;
        for (const h of hits) mediaPipeHits.push(`${f}: ${h}`);
      }
    }
    rows.push({ file: f, kind: isEntry ? 'entry' : isJs ? 'chunk' : 'css', raw: fmtKb(raw), gzip: fmtKb(gz), mediapipe: mediaPipe });
  }
  console.table(rows);
  console.log(`[bundle] entry chunk(s): ${entries.join(', ') || '(none found in index.html)'}`);
  console.log(`[bundle] total JS gzip: ${fmtKb(totalJs)} (budget ${fmtKb(budgets.totalJsGz)})`);
  console.log(`[bundle] entry JS gzip: ${fmtKb(entryGz)} (budget ${fmtKb(budgets.entryGz)}${flags.strict ? '' : ', advisory until --strict'})`);
  const result = evaluateBudgets({ totalJsGz: totalJs, entryGz, budgets, mediaPipeHits }, flags.strict);
  console.log(`entry-chunk MediaPipe check: ${result.mediaPipeStatus}`);
  for (const w of result.warnings) console.warn(`[bundle] WARN ${w}`);
  for (const f of result.failures) console.error(`[bundle] FAIL ${f}`);
  return result.failures.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
