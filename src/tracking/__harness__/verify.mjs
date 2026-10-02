/* global process */
/* eslint-disable no-console */
// Real-inference verification for W3 (not a committed test; run manually):
//   npx vite --port 6213 &  node src/tracking/__harness__/verify.mjs [GPU|CPU] [mirrored=1]
// Loads the harness in headless Chromium (SwiftShader WebGL), runs REAL MediaPipe tasks on a
// synthetic input and prints delegates, mask orientation, timings, and quadrant mass checks.
import { chromium } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const delegate = process.argv[2] ?? 'GPU';
const mirrored = (process.argv[3] ?? '1') !== '0';
const base = process.env.W3_URL ?? 'http://localhost:6213';
// Optional still-photo case. The photo is NOT part of the repository (private, outside the app tree);
// point W3_FIXTURE at a local JPEG/PNG of a person holding two L-shaped hands to run real inference on it.
const fixturePath = process.env.W3_FIXTURE ?? resolve(process.cwd(), '../private-fixtures/synthetic-person-hands.jpg');
const fixtureDataUrl = existsSync(fixturePath)
  ? `data:image/${fixturePath.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(fixturePath).toString('base64')}`
  : null;

const browser = await chromium.launch({
  headless: true,
  // W3_NO_WEBGL=1 simulates a device without WebGL2 to exercise the GPU→CPU fallback.
  args: process.env.W3_NO_WEBGL
    ? ['--disable-webgl', '--disable-webgl2', '--disable-gpu']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle'],
});
const page = await browser.newPage();
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`pageerror: ${e.message}`));
await page.goto(`${base}/src/tracking/__harness__/index.html`);
await page.waitForFunction(() => !!window.__w3);

const out = await page.evaluate(async ({ delegate, mirrored, fixtureDataUrl }) => {
  const t0 = performance.now();
  const tracker = await window.__w3.ensureTracker({ delegate, mirrored, segmentationDelegate: delegate });
  const initMs = performance.now() - t0;
  const results = { initMs: Math.round(initMs), webgl2: !!document.createElement('canvas').getContext('webgl2'), delegates: tracker.getInfo().delegates, cases: {} };
  // Person in the TOP-LEFT quadrant of the un-mirrored frame → display-space mass should be
  // top-left when not mirrored, top-right when mirrored.
  for (const [name, pos] of Object.entries({ topLeft: { x: 0.25, y: 0.3 }, bottomRight: { x: 0.75, y: 0.75 } })) {
    window.__w3.startSynthetic(pos);
    const video = document.getElementById('video');
    const ct0 = video.currentTime;
    await new Promise((r) => { const tick = () => (video.readyState >= 2 && video.currentTime > ct0 + 0.3 ? r() : setTimeout(tick, 50)); tick(); });
    await window.__w3.run(3); // warm up / flush the previous scene
    const { frame, info } = await window.__w3.run(6);
    const q = window.__w3.maskQuadrants();
    results.cases[name] = {
      hands: frame?.hands.length, face: !!frame?.face,
      faceCenter: frame?.face ? [+((frame.face.faceBox.x + frame.face.faceBox.w / 2).toFixed(3)), +((frame.face.faceBox.y + frame.face.faceBox.h / 2).toFixed(3))] : null,
      timings: frame ? Object.fromEntries(Object.entries(frame.timings).map(([k, v]) => [k, +v.toFixed(1)])) : null,
      maskNative: info?.lastMaskSize, fromGpu: info?.lastMaskFromGpu, flippedY: info?.lastMaskFlippedY, labels: info?.segmentationLabels,
      quadrants: q?.map((v) => +v.toFixed(3)), warnings: info?.warnings,
    };
  }
  // Still photo (private, not in repo) with two L-shaped hands and a face: real hand inference.
  if (fixtureDataUrl) {
    await window.__w3.startImage(fixtureDataUrl);
    const video = document.getElementById('video');
    await new Promise((r) => { const tick = () => (video.readyState >= 2 && video.currentTime > 0.3 ? r() : setTimeout(tick, 50)); tick(); });
    await window.__w3.run(4);
    const { frame, info } = await window.__w3.run(8);
    const q = window.__w3.maskQuadrants();
    results.cases.photo = {
      source: frame ? `${frame.sourceWidth}x${frame.sourceHeight}` : null,
      hands: frame?.hands.map((h) => ({ side: h.side, score: +h.score.toFixed(2), size: +h.size.toFixed(3), palm: [+h.palmCenter.x.toFixed(3), +h.palmCenter.y.toFixed(3)], index: [+h.indexTip.x.toFixed(3), +h.indexTip.y.toFixed(3)], thumb: [+h.thumbTip.x.toFixed(3), +h.thumbTip.y.toFixed(3)] })),
      face: frame?.face ? { leftEye: [+frame.face.leftEye.x.toFixed(3), +frame.face.leftEye.y.toFixed(3)], rightEye: [+frame.face.rightEye.x.toFixed(3), +frame.face.rightEye.y.toFixed(3)], roll: +(frame.face.roll * 180 / Math.PI).toFixed(1), eyeOpen: [+frame.face.eyeOpenLeft.toFixed(2), +frame.face.eyeOpenRight.toFixed(2)], mouthOpen: +frame.face.mouthOpen.toFixed(2), smile: +frame.face.smile.toFixed(2), blendshapes: Object.keys(frame.face.blendshapes).length, transformLen: frame.face.transform?.length ?? 0, box: Object.fromEntries(Object.entries(frame.face.faceBox).map(([k, v]) => [k, +v.toFixed(3)])) } : null,
      timings: frame ? Object.fromEntries(Object.entries(frame.timings).map(([k, v]) => [k, +v.toFixed(1)])) : null,
      quadrants: q?.map((v) => +v.toFixed(3)), maskNative: info?.lastMaskSize, warnings: info?.warnings,
    };
  }
  return results;
}, { delegate, mirrored, fixtureDataUrl });

console.log(JSON.stringify({ delegate, mirrored, ...out }, null, 2));
const errs = consoleMsgs.filter((m) => /error|pageerror/i.test(m));
if (errs.length) console.log('console errors:\n' + errs.join('\n'));
await browser.close();
