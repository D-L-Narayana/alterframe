#!/usr/bin/env node
/**
 * Shader GPU verification: compiles every pass on a real WebGL2 context (headless Chromium
 * with SwiftShader — a CPU rasteriser, so every timing printed here is informational only) and
 * checks rendered pixels of each preset on the procedural test scene, including the look-tuning
 * extremes (defaults must be a no-op; each knob must move pixels in its documented direction).
 *
 * One-shot (starts and stops the dev server itself):
 *   node src/render/shaders/__harness__/run-verify.mjs
 * Against a running harness server (`npx vite --port 6215 --host 127.0.0.1`):
 *   node src/render/shaders/__harness__/verify.mjs [--url http://127.0.0.1:6215] [--out <dir>]
 * Exits non-zero on any failure. Writes PNG snapshots to --out (default: the OS temp dir) for eyeballing.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('--url', 'http://127.0.0.1:6215').replace(/\/$/, '');
const OUT = arg('--out', join(tmpdir(), 'alterframe-shader-verify'));
mkdirSync(OUT, { recursive: true });

const failures = [];
const notes = [];
function check(name, cond, detail = '') {
  if (cond) notes.push(`ok   ${name} ${detail}`);
  else failures.push(`FAIL ${name} ${detail}`);
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const spread = (m) => Math.max(...m) - Math.min(...m);
const PAPER = [0xf6, 0xf3, 0xec];
/** Mirrors DEFAULT_LOOK in src/types/render.ts (kept literal here so the script stays dependency-free). */
const DEFAULT_LOOK = { inkWidth: 1, inkThreshold: 1, halftone: 1, saturation: 1, bands: 6, grain: 1, overlayStrength: 1 };

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
await page.goto(`${BASE}/src/render/shaders/__harness__/index.html?static=1`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__shaderHarness), null, { timeout: 20000 });

// 1. Compile every pass.
const compiled = await page.evaluate(() => window.__shaderHarness.compileAll());
for (const c of compiled) check(`compile ${c.id}`, c.ok, c.ok ? '' : c.log);

async function render(opts, snap) {
  const r = await page.evaluate((o) => window.__shaderHarness.render(o), opts);
  if (snap) {
    const url = await page.evaluate(() => window.__shaderHarness.snapshot());
    writeFileSync(join(OUT, `${snap}.png`), Buffer.from(url.split(',')[1], 'base64'));
  }
  return r;
}

// 2. paper-portrait: background → paper + ink, person keeps colour, lines on edges.
const pp = await render({ preset: 'paper-portrait' }, 'paper-portrait');
check('pp wall is paper-coloured', dist(pp.probes['wall-flat'].mean, PAPER) < 28, `mean=${pp.probes['wall-flat'].mean.map(Math.round)}`);
check('pp wall-mid is paper too (gradient wall removed)', dist(pp.probes['wall-mid'].mean, PAPER) < 28, `mean=${pp.probes['wall-mid'].mean.map(Math.round)}`);
check('pp skin keeps warm hue (r > g > b)', pp.probes['skin-flat'].mean[0] > pp.probes['skin-flat'].mean[1] + 20 && pp.probes['skin-flat'].mean[1] > pp.probes['skin-flat'].mean[2] + 10, `mean=${pp.probes['skin-flat'].mean.map(Math.round)}`);
check('pp skin is saturated (not paper)', dist(pp.probes['skin-flat'].mean, PAPER) > 60);
check('pp lips are red', pp.probes['lips'].mean[0] > pp.probes['lips'].mean[1] + 50, `mean=${pp.probes['lips'].mean.map(Math.round)}`);
check('pp door edge drawn as ink (room line-art)', pp.doorColumn.edgeDark > 0.6 && pp.doorColumn.nearbyDark < 0.1, `edge=${pp.doorColumn.edgeDark.toFixed(2)} nearby=${pp.doorColumn.nearbyDark.toFixed(2)}`);
check('pp hair/skin edge has a line', pp.probes['hair-skin-edge'].darkFrac > 0.6, `dark=${pp.probes['hair-skin-edge'].darkFrac.toFixed(2)}`);
check('pp flat skin is flat (quantised, noise removed)', pp.probes['skin-flat'].std < 0.06, `std=${pp.probes['skin-flat'].std.toFixed(3)}`);
check('pp paper carries faint grain (std > 0 but small)', pp.probes['wall-flat'].std > 0.004 && pp.probes['wall-flat'].std < 0.05, `std=${pp.probes['wall-flat'].std.toFixed(3)}`);

// 3. comic + backdrop (masked): background → night city (dark, bluish), person cel colours.
const cm = await render({ preset: 'comic', persona: 'masked' }, 'comic-masked');
check('comic/masked wall replaced by dark city', cm.probes['wall-flat'].lumaMean < 0.3, `luma=${cm.probes['wall-flat'].lumaMean.toFixed(2)}`);
check('comic/masked city is blue-leaning', cm.probes['wall-flat'].mean[2] > cm.probes['wall-flat'].mean[0], `mean=${cm.probes['wall-flat'].mean.map(Math.round)}`);
check('comic/masked skin stays skin', cm.probes['skin-flat'].mean[0] > cm.probes['skin-flat'].mean[2] + 40 && cm.probes['skin-flat'].lumaMean > 0.45, `mean=${cm.probes['skin-flat'].mean.map(Math.round)}`);
check('comic/masked hoodie keeps colour (not backdrop)', cm.probes['hoodie-flat'].lumaMean > 0.3, `luma=${cm.probes['hoodie-flat'].lumaMean.toFixed(2)}`);

// 4. comic + backdrop (suit): warm paper.
const cs = await render({ preset: 'comic', persona: 'suit' }, 'comic-suit');
check('comic/suit wall replaced by warm paper', cs.probes['wall-flat'].lumaMean > 0.8 && cs.probes['wall-flat'].mean[0] >= cs.probes['wall-flat'].mean[2], `mean=${cs.probes['wall-flat'].mean.map(Math.round)}`);

// 5. comic base: room stays visible, stylised: warm, inked edges, halftone on mid-tone wall.
const cb = await render({ preset: 'comic-base' }, 'comic-base');
check('comic-base wall still visible (not replaced)', cb.probes['wall-flat'].lumaMean > 0.5 && cb.probes['wall-flat'].lumaMean < 0.98, `luma=${cb.probes['wall-flat'].lumaMean.toFixed(2)}`);
check('comic-base wall is warm (r > b)', cb.probes['wall-flat'].mean[0] > cb.probes['wall-flat'].mean[2] + 15, `mean=${cb.probes['wall-flat'].mean.map(Math.round)}`);
check('comic-base door edge inked', cb.doorColumn.edgeDark > 0.6, `edge=${cb.doorColumn.edgeDark.toFixed(2)}`);
// Halftone: compare the same mid-tone wall patch with and without the halftone pass.
const noHalf = await render({ preset: 'pass:quantize-warm' });
const withHalf = await render({ preset: 'pass:halftone' }, 'pass-halftone');
check('halftone adds periodic texture on mid-tone wall', withHalf.probes['wall-mid'].std > noHalf.probes['wall-mid'].std + 0.02, `std with=${withHalf.probes['wall-mid'].std.toFixed(3)} without=${noHalf.probes['wall-mid'].std.toFixed(3)}`);
check('halftone darkens mid-tones by at most 25 %', withHalf.probes['wall-mid'].lumaMean > noHalf.probes['wall-mid'].lumaMean * 0.75 - 0.02 && withHalf.probes['wall-mid'].lumaMean <= noHalf.probes['wall-mid'].lumaMean + 0.01, `with=${withHalf.probes['wall-mid'].lumaMean.toFixed(3)} without=${noHalf.probes['wall-mid'].lumaMean.toFixed(3)}`);

// 6. Smoothing removes noise but keeps edges.
const raw = await render({ preset: 'pass:smooth-h', noise: 0.05 });
const smoothed = await render({ preset: 'pass:smooth-v', noise: 0.05 }, 'pass-smooth');
check('smooth-v flattens noisy skin', smoothed.probes['skin-flat'].std < 0.02, `std=${smoothed.probes['skin-flat'].std.toFixed(3)} (after h only: ${raw.probes['skin-flat'].std.toFixed(3)})`);
check('smooth keeps hair/skin contrast', Math.abs(smoothed.probes['hair'].lumaMean - smoothed.probes['skin-flat'].lumaMean) > 0.4);

// 7. Quantisation yields discrete bands: few distinct luma levels across the gradient wall.
const q = await render({ preset: 'pass:quantize-clean' }, 'pass-quantize');
check('quantize keeps flat areas flat', q.probes['wall-flat'].std < 0.01 && q.probes['skin-flat'].std < 0.01, `wall=${q.probes['wall-flat'].std.toFixed(3)} skin=${q.probes['skin-flat'].std.toFixed(3)}`);

// 8. Grade: contrast + vignette + grain (grain visible as small std on a flat patch).
const g = await render({ preset: 'pass:grade-comic' }, 'pass-grade');
check('grade adds grain (std 0.005..0.04 on flat wall)', g.probes['wall-flat'].std > 0.005 && g.probes['wall-flat'].std < 0.04, `std=${g.probes['wall-flat'].std.toFixed(3)}`);

// 9. Robustness: white mask (no segmentation) → portrait shows colour everywhere + lines.
const white = await render({ preset: 'paper-portrait', mask: 'white' }, 'paper-portrait-nomask');
check('pp with all-white mask keeps wall colour (graceful fallback)', dist(white.probes['wall-flat'].mean, PAPER) > 40);

// 10. renderScale 0.5 still renders and keeps the look.
const half = await render({ preset: 'paper-portrait', renderScale: 0.5 }, 'paper-portrait-half');
check('pp @0.5 renders at half size', half.width === 320 && half.height === 180, `${half.width}x${half.height}`);
check('pp @0.5 door edge still inked', half.doorColumn.edgeDark > 0.3 && half.doorColumn.nearbyDark < 0.1, `edge=${half.doorColumn.edgeDark.toFixed(2)}`);

// 11. Larger frame timing (1280×720) — informational, SwiftShader is CPU so no threshold.
const big = await render({ preset: 'comic', persona: 'masked', width: 1280, height: 720 });
notes.push(`info 1280x720 comic: cpu ${big.cpuMs.toFixed(1)} ms, gpu ${big.gpuMs === null ? 'n/a' : big.gpuMs.toFixed(1) + ' ms'} (SwiftShader, CPU rasteriser — not representative of real GPUs)`);

// 12. Look tuning. Defaults are a no-op (bit-identical frame); each extreme moves pixels the documented way.
const ppDefault = await render({ preset: 'paper-portrait', look: { ...DEFAULT_LOOK } });
check('look: explicit DEFAULT_LOOK renders bit-identical pixels to the implicit default', ppDefault.checksum === pp.checksum, `${ppDefault.checksum} vs ${pp.checksum}`);
const thick = await render({ preset: 'paper-portrait', look: { inkWidth: 3 } }, 'look-ink-thick');
check('look: inkWidth 3 keeps the door edge at least as dark (5-px window)', thick.doorColumn.edgeDark >= pp.doorColumn.edgeDark, `thick=${thick.doorColumn.edgeDark.toFixed(2)} default=${pp.doorColumn.edgeDark.toFixed(2)}`);
check('look: inkWidth 3 widens the door line (13-px window dark fraction rises)', thick.doorColumn.edgeDarkWide > pp.doorColumn.edgeDarkWide + 0.1, `thick=${thick.doorColumn.edgeDarkWide.toFixed(2)} default=${pp.doorColumn.edgeDarkWide.toFixed(2)}`);
check('look: inkWidth 3 changes the frame (checksum differs)', thick.checksum !== pp.checksum);
const thrHi = await render({ preset: 'paper-portrait', look: { inkThreshold: 3 } }, 'look-ink-threshold-high');
const thrLo = await render({ preset: 'paper-portrait', look: { inkThreshold: 0.25 } }, 'look-ink-threshold-low');
check('look: inkThreshold 3 draws fewer dark pixels than default, 0.25 draws more', thrHi.frameDarkFrac < pp.frameDarkFrac && thrLo.frameDarkFrac > pp.frameDarkFrac, `hi=${thrHi.frameDarkFrac.toFixed(3)} default=${pp.frameDarkFrac.toFixed(3)} lo=${thrLo.frameDarkFrac.toFixed(3)}`);
const halfOff = await render({ preset: 'pass:halftone', look: { halftone: 0 } }, 'look-halftone-0');
check('look: halftone 0 removes the dot texture (wall-mid std drops vs default)', halfOff.probes['wall-mid'].std < withHalf.probes['wall-mid'].std - 0.015, `off=${halfOff.probes['wall-mid'].std.toFixed(3)} default=${withHalf.probes['wall-mid'].std.toFixed(3)}`);
check('look: halftone 0 is a no-op (wall-mid luma equals the quantize output)', Math.abs(halfOff.probes['wall-mid'].lumaMean - noHalf.probes['wall-mid'].lumaMean) < 0.01, `off=${halfOff.probes['wall-mid'].lumaMean.toFixed(3)} quantize=${noHalf.probes['wall-mid'].lumaMean.toFixed(3)}`);
const grey = await render({ preset: 'paper-portrait', look: { saturation: 0 } }, 'look-saturation-0');
check('look: saturation 0 makes the skin grey (r ≈ g ≈ b)', spread(grey.probes['skin-flat'].mean) <= 3, `mean=${grey.probes['skin-flat'].mean.map(Math.round)}`);
const vivid = await render({ preset: 'paper-portrait', look: { saturation: 2 } });
check('look: saturation 2 is more saturated than default (wider channel spread on skin)', spread(vivid.probes['skin-flat'].mean) > spread(pp.probes['skin-flat'].mean), `vivid=${spread(vivid.probes['skin-flat'].mean).toFixed(1)} default=${spread(pp.probes['skin-flat'].mean).toFixed(1)}`);
const b3 = await render({ preset: 'pass:quantize-clean', scene: 'ramp', look: { bands: 3 } }, 'look-bands-3');
const b6 = await render({ preset: 'pass:quantize-clean', scene: 'ramp' });
const b8 = await render({ preset: 'pass:quantize-clean', scene: 'ramp', look: { bands: 8 } }, 'look-bands-8');
check('look: bands 3 yields fewer luma levels than bands 8 on a grey ramp', b3.rowLevels < b8.rowLevels, `levels 3→${b3.rowLevels} 6→${b6.rowLevels} 8→${b8.rowLevels}`);
check('look: the plateau count on the ramp equals the band count (3 / 6 / 8)', b3.rowLevels === 3 && b6.rowLevels === 6 && b8.rowLevels === 8, `levels 3→${b3.rowLevels} 6→${b6.rowLevels} 8→${b8.rowLevels}`);
const grain0 = await render({ preset: 'pass:grade-comic', look: { grain: 0 } });
const grain3 = await render({ preset: 'pass:grade-comic', look: { grain: 3 } });
check('look: grain 0 flattens the wall and grain 3 roughens it (std ordering)', grain0.probes['wall-flat'].std < g.probes['wall-flat'].std && grain3.probes['wall-flat'].std > g.probes['wall-flat'].std, `0→${grain0.probes['wall-flat'].std.toFixed(3)} default→${g.probes['wall-flat'].std.toFixed(3)} 3→${grain3.probes['wall-flat'].std.toFixed(3)}`);
const ppAgain = await render({ preset: 'paper-portrait' });
check('look: rendering the default again after the extremes is still bit-identical (no state leaks between looks)', ppAgain.checksum === pp.checksum, `${ppAgain.checksum} vs ${pp.checksum}`);

check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();
for (const n of notes) console.log(n);
for (const f of failures) console.log(f);
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${notes.length} ok, ${failures.length} failed. Snapshots in ${OUT}`);
process.exit(failures.length === 0 ? 0 : 1);
