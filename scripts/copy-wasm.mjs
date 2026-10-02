// Copies the MediaPipe wasm runtime from node_modules into public/wasm (gitignored; regenerated
// on `postinstall`, `predev`, `prebuild`). The app loads it same-origin from /wasm so the CSP needs
// no third-party host. Owner: W10.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const src = resolve(process.cwd(), 'node_modules/@mediapipe/tasks-vision/wasm');
const dest = resolve(process.cwd(), 'public/wasm');
if (!existsSync(src)) {
  console.error(`[wasm] ${src} missing — run npm install first (@mediapipe/tasks-vision)`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
const files = readdirSync(dest).filter((f) => /\.(js|wasm)$/.test(f));
const required = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'];
for (const r of required) {
  if (!files.includes(r)) {
    console.error(`[wasm] expected ${r} in ${dest}`);
    process.exit(1);
  }
}
const total = files.reduce((s, f) => s + statSync(resolve(dest, f)).size, 0);
console.log(`[wasm] copied ${files.length} files (${(total / 1e6).toFixed(1)} MB) to public/wasm`);
