// Post-build gate (owner: W10): the production payload must be runnable from `dist` alone,
// including the MediaPipe models (fetched by prebuild) and wasm runtime (copied by postinstall),
// even though both are excluded from Git. Fails the build loudly otherwise.
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(process.cwd(), 'dist');
const fail = (msg) => {
  console.error(`[verify-dist] ${msg}`);
  process.exit(1);
};
if (!existsSync(dist)) fail('dist/ missing — run `vite build` first');

const required = [
  ['index.html', 200],
  ['models/hand_landmarker.task', 7_000_000],
  ['models/face_landmarker.task', 3_000_000],
  ['models/selfie_segmenter.tflite', 200_000],
  ['wasm/vision_wasm_internal.js', 100_000],
  ['wasm/vision_wasm_internal.wasm', 5_000_000],
  ['wasm/vision_wasm_nosimd_internal.js', 100_000],
  ['wasm/vision_wasm_nosimd_internal.wasm', 5_000_000],
  ['favicon.svg', 100],
  ['manifest.webmanifest', 100],
];
for (const [rel, minBytes] of required) {
  const p = resolve(dist, rel);
  if (!existsSync(p)) fail(`missing ${rel}`);
  const size = statSync(p).size;
  if (size < minBytes) fail(`${rel} too small (${size} B < ${minBytes} B)`);
}

const assets = resolve(dist, 'assets');
if (!existsSync(assets) || readdirSync(assets).filter((f) => f.endsWith('.js')).length === 0) fail('no JS bundle in dist/assets');

// The entry must not contain inline scripts (CSP script-src 'self').
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].filter((m) => m[1].trim().length > 0);
if (inline.length) fail(`index.html contains ${inline.length} inline <script> block(s); CSP forbids them`);

// No reference to a third-party CDN in the built JS (models/wasm must be same-origin).
for (const f of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
  const js = readFileSync(resolve(assets, f), 'utf8');
  if (/cdn\.jsdelivr\.net\/npm\/@mediapipe|storage\.googleapis\.com\/mediapipe-models/.test(js)) {
    fail(`${f} references a third-party MediaPipe CDN; wasm/models must load from /wasm and /models`);
  }
}
// Dev/e2e hooks must be tree-shaken out of a plain production build (kept only for VITE_E2E=1 builds).
if (process.env.VITE_E2E !== '1') {
  for (const f of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
    const js = readFileSync(resolve(assets, f), 'utf8');
    if (/__alterframe\b|injectTracking|mockTracking/.test(js)) {
      fail(`${f} still contains dev/e2e hook code (__alterframe / injectTracking / mockTracking); gate it behind import.meta.env.DEV || VITE_E2E`);
    }
  }
}
console.log('[verify-dist] ok — dist contains index, hashed assets, models and wasm; no inline scripts');
