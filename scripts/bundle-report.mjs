// Prints gzip sizes of dist/assets/*.js|css and checks the plan §5.7 budget (JS ≤ 450 kB gz, excluding wasm/models).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const BUDGET_JS_GZ = Number(process.env.BUNDLE_BUDGET_JS_GZ ?? 450 * 1024);
const dir = resolve(process.cwd(), 'dist/assets');
let totalJs = 0;
const rows = [];
for (const f of readdirSync(dir).sort()) {
  if (!/\.(js|css)$/.test(f)) continue;
  const raw = statSync(resolve(dir, f)).size;
  const gz = gzipSync(readFileSync(resolve(dir, f))).length;
  if (f.endsWith('.js')) totalJs += gz;
  rows.push({ file: f, raw: `${(raw / 1024).toFixed(1)} kB`, gzip: `${(gz / 1024).toFixed(1)} kB` });
}
console.table(rows);
console.log(`[bundle] total JS gzip: ${(totalJs / 1024).toFixed(1)} kB (budget ${(BUDGET_JS_GZ / 1024).toFixed(0)} kB)`);
if (totalJs > BUDGET_JS_GZ) {
  console.error('[bundle] over budget');
  process.exit(1);
}
