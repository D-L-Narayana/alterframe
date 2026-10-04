/* eslint-disable no-console */
/* global process */
// Real-browser inspection of the capture recorder/snapshot and the adaptive ladder (not a mock).
//   Easiest: node src/capture/__harness__/run-inspect.mjs      (starts Vite on 6219, runs this, stops Vite)
//   Manual:  node node_modules/vite/bin/vite.js --port 6219 --host 127.0.0.1   then
//            node src/capture/__harness__/inspect.mjs
// Writes test-results/capture-harness/{inspection-results.json,inspection-screenshot.png} (gitignored folder).
// Records the synthetic canvas for every aspect, decodes the resulting WebM/MP4 in a <video>, checks
// dimensions/duration and samples pixels to prove the centre crop removed the edge bands; decodes
// PNG/JPEG/WebP snapshots; exercises the max-duration self-finalize + pending result; drives the
// adaptive ladder under simulated tracking-heavy load (ladder order) and render-heavy load (cost-aware branch).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Artefacts go to the gitignored test-results/ folder (keeps the public payload free of rasters).
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../test-results/capture-harness');
mkdirSync(outDir, { recursive: true });
const url = process.env.HARNESS_URL ?? 'http://127.0.0.1:6219/src/capture/__harness__/index.html';

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => Boolean(window.__captureHarness));
await page.waitForTimeout(500);

const results = { url, aspects: {}, snapshots: {}, formats: {}, capped: null, errors: {}, perf: {}, consoleErrors };

// --- pixel helper evaluated in the page: decode a blob and sample points ------------------------
const sampleScript = `(() => {
async function sampleBlob(blob, kind) {
  const samples = (ctx, w, h) => {
    const px = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3);
    return { w, h, topLeft: px(2, 2), leftMid: px(2, h / 2), rightMid: px(w - 3, h / 2), topMid: px(w / 2, 2), bottomMid: px(w / 2, h - 3), centre: px(w / 2, h / 2) };
  };
  if (kind === 'image') {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0);
    return samples(ctx, bmp.width, bmp.height);
  }
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('video decode error')); });
  // MediaRecorder WebM often reports duration Infinity until seeked to the end (no cues).
  let duration = v.duration;
  if (!Number.isFinite(duration)) {
    await new Promise((res) => { v.ontimeupdate = () => { v.ontimeupdate = null; res(); }; v.currentTime = 1e9; });
    duration = v.duration;
  }
  await new Promise((res) => { v.onseeked = res; v.currentTime = Math.min(0.4, Math.max(0, duration / 2)); });
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(v, 0, 0);
  const s = samples(ctx, v.videoWidth, v.videoHeight);
  URL.revokeObjectURL(v.src);
  return { ...s, duration };
}
window.__sampleBlob = sampleBlob;
})()`;
await page.evaluate(sampleScript);

for (const aspect of ['source', '9:16', '16:9', '1:1']) {
  results.aspects[aspect] = await page.evaluate(async (aspect) => {
    const h = window.__captureHarness;
    const t0 = performance.now();
    const r = await h.record(aspect, 1500);
    const wall = performance.now() - t0;
    const stateAfter = h.recorder.state;
    const elapsedAfter = h.recorder.elapsedMs;
    let decoded = null, decodeError = null;
    try { decoded = await window.__sampleBlob(r.blob, 'video'); } catch (e) { decodeError = String(e && e.message || e); }
    return { mime: r.mime, size: r.size, durationMs: r.durationMs, wallMs: wall, stateAfter, elapsedAfter, blobType: r.blob.type, decoded, decodeError };
  }, aspect);
  console.log(aspect, JSON.stringify(results.aspects[aspect]));
}

for (const aspect of ['source', '9:16', '16:9', '1:1']) {
  results.snapshots[aspect] = await page.evaluate(async (aspect) => {
    const blob = await window.__captureHarness.snapshot(aspect);
    const s = await window.__sampleBlob(blob, 'image');
    return { type: blob.type, size: blob.size, ...s };
  }, aspect);
  console.log('snapshot', aspect, JSON.stringify(results.snapshots[aspect]));
}

// --- snapshot formats: requested type honoured, decodable, same crop -----------------------------
for (const [format, quality] of [['jpeg', 0.8], ['webp', 0.8], ['png', undefined]]) {
  results.formats[format] = await page.evaluate(async ({ format, quality }) => {
    const opts = quality === undefined ? { format } : { format, quality };
    const blob = await window.__captureHarness.snapshot('1:1', opts);
    const s = await window.__sampleBlob(blob, 'image');
    return { requested: opts, type: blob.type, size: blob.size, ...s };
  }, { format, quality });
  console.log('format', format, JSON.stringify(results.formats[format]));
}

// --- max duration: self-finalize + pending result ------------------------------------------------
results.capped = await page.evaluate(async () => {
  const h = window.__captureHarness;
  const r = await h.recordCapped('source', 1500);
  let decoded = null, decodeError = null;
  try { decoded = await window.__sampleBlob(r.blob, 'video'); } catch (e) { decodeError = String(e && e.message || e); }
  const { blob, ...rest } = r;
  return { ...rest, blobType: blob.type, decoded, decodeError, stateAtEnd: h.recorder.state, pendingAtEnd: h.recorder.hasPendingResult };
});
console.log('capped', JSON.stringify(results.capped));

// --- error paths in the real browser --------------------------------------------------------------
results.errors = await page.evaluate(async () => {
  const h = window.__captureHarness;
  const out = {};
  try { await h.recorder.stop(); out.stopIdle = 'resolved?!'; } catch (e) { out.stopIdle = e.message; }
  await h.recorder.start({ aspect: 'source' });
  try { await h.recorder.start({ aspect: 'source' }); out.doubleStart = 'resolved?!'; } catch (e) { out.doubleStart = e.message; }
  await new Promise((r) => setTimeout(r, 300));
  const r = await h.recorder.stop();
  out.afterDoubleStartStopSize = r.blob.size;
  try { await h.recorder.start({ aspect: 'source', mimeCandidates: ['video/x-nonsense'] }); out.noMime = 'resolved?!'; } catch (e) { out.noMime = e.message; }
  out.stateAtEnd = h.recorder.state;
  out.isTypeSupported = {
    'video/mp4;codecs=avc1': MediaRecorder.isTypeSupported('video/mp4;codecs=avc1'),
    'video/webm;codecs=vp9': MediaRecorder.isTypeSupported('video/webm;codecs=vp9'),
    'video/webm;codecs=vp8': MediaRecorder.isTypeSupported('video/webm;codecs=vp8'),
    'video/webm': MediaRecorder.isTypeSupported('video/webm'),
  };
  return out;
});
console.log('errors', JSON.stringify(results.errors));

// --- perf monitor + adaptive ladder under simulated load -----------------------------------------
results.perf = await page.evaluate(async () => {
  const h = window.__captureHarness;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => ({ fps: h.monitor.fps(), quality: h.getQuality(), depth: h.ladderDepth(), samples5s: h.monitor.recent(5000).length });
  const before = snap();
  // Tracking-heavy frames: the ladder order applies from wherever the policy currently is
  // (from default quality the first rung is inferenceMaxHeight 720 → 480, renderScale untouched).
  h.setLoad(true, 'tracking');
  await wait(6500);
  const under = snap();
  const expectedUnder = h.ladderFrom(before.quality, under.depth - before.depth);
  h.setLoad(false);
  // Step back up: the EMA recovery (~1 s) must leave the 5 s window, plus the cooldown; poll up to 30 s
  // (a single slow sample inside the window blocks the step up, and this host is shared).
  const t0 = performance.now();
  let after = snap();
  while (!(after.depth < under.depth) && performance.now() - t0 < 30_000) {
    await wait(250);
    after = snap();
  }
  after.afterMs = Math.round(performance.now() - t0);
  // Render-heavy frames: the first step DOWN must be a renderScale rung (cost-aware branch); step-ups
  // that happen while the fps is still high are ignored.
  let prev = h.getQuality();
  h.setLoad(true, 'render');
  const t1 = performance.now();
  let firstDown = null;
  while (performance.now() - t1 < 12_000) {
    await wait(100);
    const q = h.getQuality();
    if (q === prev) continue;
    if (h.ladderDepth(q) > h.ladderDepth(prev)) {
      firstDown = { from: prev, to: q, ladderNext: h.ladderFrom(prev, 1), afterMs: Math.round(performance.now() - t1) };
      break;
    }
    prev = q;
  }
  h.setLoad(false);
  return { before, under, expectedUnder, after, costAware: firstDown };
});
console.log('perf', JSON.stringify(results.perf));

// --- UI path: clicking Record → Stop must trigger a real browser download with the contract filename
await page.selectOption('#aspect', '9:16');
await page.click('#record');
await page.waitForFunction(() => document.getElementById('record')?.textContent === 'Stop');
await page.waitForTimeout(1200);
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#record')]);
results.uiDownload = { suggested: dl.suggestedFilename(), statusText: await page.textContent('#status') };
await dl.cancel();
const [snapDl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#snapshot')]);
results.uiSnapshot = { suggested: snapDl.suggestedFilename() };
await snapDl.cancel();
// Format select → the download is named after the format the browser really produced.
results.uiFormats = {};
for (const format of ['jpeg', 'webp']) {
  await page.selectOption('#format', format);
  const [fDl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#snapshot')]);
  results.uiFormats[format] = fDl.suggestedFilename();
  await fDl.cancel();
}
await page.selectOption('#format', 'png');
// Max-duration demo: Record with a 1500 ms cap → button turns into Collect on its own → Collect downloads.
await page.fill('#maxDuration', '1500');
await page.selectOption('#aspect', 'source');
await page.click('#record');
await page.waitForFunction(() => document.getElementById('record')?.textContent === 'Stop');
await page.waitForFunction(() => document.getElementById('record')?.textContent === 'Collect', null, { timeout: 15000 });
// The status line refreshes every 10 frames; wait for it rather than sampling it immediately.
try {
  await page.waitForFunction(() => /finished on its own/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 15000 });
} catch {
  /* reported through the assertion below */
}
results.uiCapped = { statusWhilePending: await page.textContent('#status') };
const [capDl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#record')]);
results.uiCapped.suggested = capDl.suggestedFilename();
results.uiCapped.buttonAfterCollect = await page.textContent('#record');
await capDl.cancel();
await page.fill('#maxDuration', '600000');
console.log('ui', JSON.stringify({ ...results.uiDownload, snapshot: results.uiSnapshot, formats: results.uiFormats, capped: results.uiCapped }));

await page.screenshot({ path: path.join(outDir, 'inspection-screenshot.png') });
writeFileSync(path.join(outDir, 'inspection-results.json'), JSON.stringify(results, null, 2));
await browser.close();

// --- assertions -----------------------------------------------------------------------------------
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const RED = [224, 32, 32], BLUE = [32, 64, 224], GREEN = [32, 192, 64], YELLOW = [224, 192, 32], CENTRE = [48, 48, 54];
const fails = [];
const expectDims = { source: [1280, 720], '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };
for (const [aspect, r] of Object.entries(results.aspects)) {
  if (!(r.size > 0)) fails.push(`${aspect}: empty blob`);
  if (r.stateAfter !== 'idle' || r.elapsedAfter !== 0) fails.push(`${aspect}: state not reset`);
  if (!(r.durationMs >= 1400 && r.durationMs < 2500)) fails.push(`${aspect}: durationMs ${r.durationMs}`);
  if (!r.decoded) { fails.push(`${aspect}: video did not decode (${r.decodeError})`); continue; }
  const [w, h] = expectDims[aspect];
  if (r.decoded.w !== w || r.decoded.h !== h) fails.push(`${aspect}: decoded ${r.decoded.w}x${r.decoded.h}, expected ${w}x${h}`);
  if (!(r.decoded.duration > 1.0)) fails.push(`${aspect}: decoded duration ${r.decoded.duration}`);
}
const checkCrop = (label, s) => {
  if (label.endsWith('source') || label.endsWith('16:9')) {
    if (!near(s.leftMid, RED)) fails.push(`${label}: left band missing ${s.leftMid}`);
    if (!near(s.rightMid, BLUE)) fails.push(`${label}: right band missing ${s.rightMid}`);
  }
  if (label.endsWith('9:16')) {
    // full height kept: top green / bottom yellow; width trimmed: left/right now centre grey
    if (!near(s.topMid, GREEN)) fails.push(`${label}: top band missing ${s.topMid}`);
    if (!near(s.bottomMid, YELLOW)) fails.push(`${label}: bottom band missing ${s.bottomMid}`);
    if (!near(s.leftMid, CENTRE)) fails.push(`${label}: left should be cropped to centre grey, got ${s.leftMid}`);
    if (!near(s.rightMid, CENTRE)) fails.push(`${label}: right should be cropped to centre grey, got ${s.rightMid}`);
  }
  if (label.endsWith('1:1')) {
    if (!near(s.topMid, GREEN)) fails.push(`${label}: top band missing ${s.topMid}`);
    if (!near(s.leftMid, CENTRE)) fails.push(`${label}: left should be centre grey, got ${s.leftMid}`);
  }
};
for (const [aspect, r] of Object.entries(results.aspects)) if (r.decoded) checkCrop(`video ${aspect}`, r.decoded);
for (const [aspect, s] of Object.entries(results.snapshots)) {
  const [w, h] = expectDims[aspect];
  if (s.w !== w || s.h !== h) fails.push(`snapshot ${aspect}: ${s.w}x${s.h}`);
  if (s.type !== 'image/png' || !(s.size > 0)) fails.push(`snapshot ${aspect}: bad blob`);
  checkCrop(`snapshot ${aspect}`, s);
}
// Formats: Chromium encodes JPEG and WebP, so the requested type must come back (a PNG here would mean the
// fallback engaged unexpectedly); dimensions and crop pixels must match the PNG path.
const expectType = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
for (const [format, s] of Object.entries(results.formats)) {
  if (s.type !== expectType[format]) fails.push(`format ${format}: blob type ${s.type}, expected ${expectType[format]}`);
  if (!(s.size > 0)) fails.push(`format ${format}: empty blob`);
  if (s.w !== 1080 || s.h !== 1080) fails.push(`format ${format}: decoded ${s.w}x${s.h}, expected 1080x1080`);
  checkCrop(`format ${format} 1:1`, s);
}
// Max duration: state sequence, timing, pending-result semantics, decodable output.
const c = results.capped;
if (JSON.stringify(c.states) !== JSON.stringify(['recording', 'finalizing', 'idle'])) fails.push(`capped: state sequence ${JSON.stringify(c.states)}`);
// Cap 1500 ms: finalize starts when the timer fires (never early); the MediaRecorder stop event normally
// follows within a few hundred ms, with the recorder's own 5 s safety net as the upper bound.
if (!(c.finishedAfterMs >= 1400 && c.finishedAfterMs < 8000)) fails.push(`capped: finalized after ${c.finishedAfterMs} ms (cap 1500)`);
if (!(c.durationMs >= 1500 && c.durationMs < 3000)) fails.push(`capped: durationMs ${c.durationMs} (cap 1500)`);
if (c.pendingBeforeCollect !== true) fails.push('capped: hasPendingResult was not true after the self-finalize');
if (!/collect the previous recording with stop\(\) first/i.test(c.startWhilePending)) fails.push(`capped: start() while pending → ${c.startWhilePending}`);
if (!(c.size > 0)) fails.push('capped: empty blob from stop()');
if (c.pendingAfterCollect !== false) fails.push('capped: hasPendingResult still true after stop() collected the result');
if (!/not recording/i.test(c.secondStop)) fails.push(`capped: second stop() → ${c.secondStop}`);
if (c.stateAtEnd !== 'idle' || c.pendingAtEnd !== false) fails.push(`capped: end state ${c.stateAtEnd}, pending ${c.pendingAtEnd}`);
if (!c.decoded) fails.push(`capped: video did not decode (${c.decodeError})`);
else {
  if (c.decoded.w !== 1280 || c.decoded.h !== 720) fails.push(`capped: decoded ${c.decoded.w}x${c.decoded.h}`);
  if (!(c.decoded.duration > 1.0)) fails.push(`capped: decoded duration ${c.decoded.duration}`);
}
if (!/not recording/i.test(results.errors.stopIdle)) fails.push(`stopIdle: ${results.errors.stopIdle}`);
if (!/already recording/i.test(results.errors.doubleStart)) fails.push(`doubleStart: ${results.errors.doubleStart}`);
if (!/no supported video format/i.test(results.errors.noMime)) fails.push(`noMime: ${results.errors.noMime}`);
if (results.errors.stateAtEnd !== 'idle') fails.push('state not idle at end');
// Adaptive ladder v2: tracking-heavy load steps down the ladder in order (from default quality the first rung
// is inferenceMaxHeight 480 with renderScale untouched); without load it steps back up; render-heavy load takes
// a renderScale rung first (cost-aware branch) unless renderScale is already at its floor.
const QUALITY_FIELDS = ['renderScale', 'maxDpr', 'segmentationStride', 'inferenceMaxHeight', 'faceStride'];
const sameQuality = (a, b) => Boolean(a && b) && QUALITY_FIELDS.every((k) => a[k] === b[k]);
const p = results.perf;
if (!(p.under.depth > p.before.depth)) fails.push(`adaptive did not step down under tracking-heavy load: before ${JSON.stringify(p.before)} under ${JSON.stringify(p.under)}`);
if (!sameQuality(p.under.quality, p.expectedUnder)) fails.push(`ladder order under tracking-heavy load: got ${JSON.stringify(p.under.quality)}, expected ${JSON.stringify(p.expectedUnder)} (${p.under.depth - p.before.depth} rung(s) down from ${JSON.stringify(p.before.quality)})`);
if (p.before.depth === 0 && p.under.depth > 0 && (p.under.quality.inferenceMaxHeight !== 480 || p.under.quality.renderScale !== 1)) fails.push(`first rung from default quality should be inferenceMaxHeight 480 with renderScale 1: ${JSON.stringify(p.under.quality)}`);
if (!(p.after.depth < p.under.depth)) fails.push(`adaptive did not step back up within 30 s of removing the load: ${JSON.stringify(p.after)}`);
if (!p.costAware) fails.push('cost-aware: no step down within 12 s of render-heavy load');
else {
  const { from, to, ladderNext } = p.costAware;
  if (from.renderScale > 0.5) {
    if (!(to.renderScale < from.renderScale)) fails.push(`cost-aware: expected a renderScale rung first, got ${JSON.stringify(to)} from ${JSON.stringify(from)}`);
    for (const k of ['inferenceMaxHeight', 'segmentationStride', 'faceStride']) {
      if (to[k] !== from[k]) fails.push(`cost-aware: ${k} changed ${from[k]} → ${to[k]} instead of renderScale only`);
    }
  } else if (!sameQuality(to, ladderNext)) {
    fails.push(`cost-aware at the renderScale floor should fall back to the ladder: got ${JSON.stringify(to)}, expected ${JSON.stringify(ladderNext)}`);
  }
}
if (!/^alterframe-\d{8}-\d{6}\.(mp4|webm)$/.test(results.uiDownload.suggested)) fails.push(`ui download name: ${results.uiDownload.suggested}`);
if (!/^alterframe-\d{8}-\d{6}\.png$/.test(results.uiSnapshot.suggested)) fails.push(`ui snapshot name: ${results.uiSnapshot.suggested}`);
if (!/^alterframe-\d{8}-\d{6}\.jpg$/.test(results.uiFormats.jpeg)) fails.push(`ui jpeg snapshot name: ${results.uiFormats.jpeg}`);
if (!/^alterframe-\d{8}-\d{6}\.webp$/.test(results.uiFormats.webp)) fails.push(`ui webp snapshot name: ${results.uiFormats.webp}`);
if (!/^alterframe-\d{8}-\d{6}\.(mp4|webm)$/.test(results.uiCapped.suggested)) fails.push(`ui capped download name: ${results.uiCapped.suggested}`);
if (!/finished on its own/.test(results.uiCapped.statusWhilePending)) fails.push(`ui capped status: ${results.uiCapped.statusWhilePending}`);
if (results.uiCapped.buttonAfterCollect !== 'Record') fails.push(`ui capped button after collect: ${results.uiCapped.buttonAfterCollect}`);
if (consoleErrors.length) fails.push(`console noise: ${consoleErrors.join(' | ')}`);

if (fails.length) { console.error('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('\nALL BROWSER CHECKS PASSED');
