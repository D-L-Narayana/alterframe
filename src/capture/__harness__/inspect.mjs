/* eslint-disable no-console */
/* global process */
// Real-browser inspection of the W9 recorder/snapshot (not a mock). Run with the harness served:
//   npx vite --port 6219 --host 127.0.0.1   (in app/)
//   node src/capture/__harness__/inspect.mjs      → writes test-results/w9-capture/{inspection-results.json,inspection-screenshot.png}
// Records the synthetic canvas for every aspect, decodes the resulting WebM/MP4 in a <video>,
// checks dimensions/duration, and samples pixels to prove the centre crop removed the edge bands.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Artefacts go to the gitignored test-results/ folder (keeps the public payload free of rasters).
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../test-results/w9-capture');
import { mkdirSync } from 'node:fs';
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

const results = { url, aspects: {}, snapshots: {}, errors: {}, perf: {}, consoleErrors };

// --- pixel helper evaluated in the page: decode a blob and sample points ------------------------
const sampleScript = `(() => {
async function sampleBlob(blob, kind) {
  const samples = (ctx, w, h) => {
    const px = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3);
    return { w, h, topLeft: px(2, 2), leftMid: px(2, h / 2), rightMid: px(w - 3, h / 2), topMid: px(w / 2, 2), bottomMid: px(w / 2, h - 3), centre: px(w / 2, h / 2) };
  };
  if (kind === 'png') {
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
    const s = await window.__sampleBlob(blob, 'png');
    return { type: blob.type, size: blob.size, ...s };
  }, aspect);
  console.log('snapshot', aspect, JSON.stringify(results.snapshots[aspect]));
}

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

// --- perf monitor + adaptive policy under simulated load ------------------------------------------
results.perf = await page.evaluate(async () => {
  const h = window.__captureHarness;
  const before = { fps: h.monitor.fps(), quality: h.getQuality() };
  h.setLoad(true);
  await new Promise((r) => setTimeout(r, 6500));
  const under = { fps: h.monitor.fps(), quality: h.getQuality(), samples5s: h.monitor.recent(5000).length };
  h.setLoad(false);
  await new Promise((r) => setTimeout(r, 13000)); // EMA recovery (~1 s) must leave the 5 s window, plus cooldown
  const after = { fps: h.monitor.fps(), quality: h.getQuality() };
  return { before, under, after };
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
console.log('ui', JSON.stringify({ ...results.uiDownload, snapshot: results.uiSnapshot }));

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
if (!/not recording/i.test(results.errors.stopIdle)) fails.push(`stopIdle: ${results.errors.stopIdle}`);
if (!/already recording/i.test(results.errors.doubleStart)) fails.push(`doubleStart: ${results.errors.doubleStart}`);
if (!/no supported video format/i.test(results.errors.noMime)) fails.push(`noMime: ${results.errors.noMime}`);
if (results.errors.stateAtEnd !== 'idle') fails.push('state not idle at end');
if (!(results.perf.under.quality.renderScale < 1)) fails.push(`adaptive did not step down under load: ${JSON.stringify(results.perf.under)}`);
if (!(results.perf.after.quality.renderScale > results.perf.under.quality.renderScale)) fails.push(`adaptive did not step back up: ${JSON.stringify(results.perf.after)}`);
if (!/^alterframe-\d{8}-\d{6}\.(mp4|webm)$/.test(results.uiDownload.suggested)) fails.push(`ui download name: ${results.uiDownload.suggested}`);
if (!/^alterframe-\d{8}-\d{6}\.png$/.test(results.uiSnapshot.suggested)) fails.push(`ui snapshot name: ${results.uiSnapshot.suggested}`);
if (consoleErrors.length) fails.push(`console noise: ${consoleErrors.join(' | ')}`);

if (fails.length) { console.error('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('\nALL BROWSER CHECKS PASSED');
