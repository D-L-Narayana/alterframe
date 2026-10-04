/* global process */
/* eslint-disable no-console */
// Real-inference verification for the tracking module (not a committed test; run manually):
//   npx vite --port 6213 &  node src/tracking/__harness__/verify.mjs [GPU|CPU] [mirrored=1]
// or, as ONE foreground command (starts the Vite dev server in-process on 6213 and closes it):
//   node src/tracking/__harness__/verify.mjs [GPU|CPU] [mirrored=1] --serve
// Loads the harness in headless Chromium and runs REAL MediaPipe tasks on a synthetic input:
//   1. orientation cases — person top-left / bottom-right → mask quadrant mass, face centre;
//   2. inference-resolution parity — the SAME 1280×720 scene analysed at inferenceMaxHeight
//      720 / 480 / 360 (input size, face centre, mask quadrants, mean timings, deltas vs 720);
//   3. face stride 1 vs 3 at the 720 rung (face runs per analysed frame, mean faceMs / totalMs).
// Chromium here renders with SwiftShader (software GL): every timing printed is a
// "SwiftShader / sandbox" number — compare rungs relative to each other, never to a real GPU.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const delegate = args[0] ?? 'GPU';
const mirrored = (args[1] ?? '1') !== '0';
const port = 6213;
// --serve: same dev server as `npx vite --port 6213` (project vite.config), owned by this process.
let devServer = null;
if (flags.has('--serve')) {
  const { createServer } = await import('vite');
  devServer = await createServer({ server: { port, strictPort: true, host: 'localhost' }, logLevel: 'warn' });
  await devServer.listen();
}
const base = process.env.W3_URL ?? `http://localhost:${port}`;
// Optional still-photo case: W3_FIXTURE=/path/to/photo.(jpg|png) of a person holding two L-shaped
// hands. No photo ships in the repository; nothing is read unless the variable points at a file.
const fixturePath = process.env.W3_FIXTURE;
const fixtureDataUrl = fixturePath && existsSync(fixturePath)
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
  const w3 = window.__w3;
  const video = document.getElementById('video');
  const r3 = (v) => +v.toFixed(3);
  const faceCenter = (frame) => (frame?.face ? [r3(frame.face.faceBox.x + frame.face.faceBox.w / 2), r3(frame.face.faceBox.y + frame.face.faceBox.h / 2)] : null);
  const timingsOf = (t) => (t ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +v.toFixed(1)])) : null);
  const sizeOf = (s) => (s ? `${s.width}x${s.height}` : null);
  /** Wait until the (new) synthetic stream has advanced past its first decoded frames. */
  const settle = async () => {
    const ct0 = video.currentTime;
    await new Promise((r) => { const tick = () => (video.readyState >= 2 && video.currentTime > ct0 + 0.3 ? r() : setTimeout(tick, 50)); tick(); });
  };

  const t0 = performance.now();
  const tracker = await w3.ensureTracker({ delegate, mirrored, segmentationDelegate: delegate, inferenceMaxHeight: 720, faceStride: 1 });
  const results = {
    environment: 'headless Chromium with SwiftShader (software GL) — sandbox numbers, not a real GPU',
    initMs: Math.round(performance.now() - t0),
    webgl2: !!document.createElement('canvas').getContext('webgl2'),
    delegates: tracker.getInfo().delegates,
    cases: {},
  };

  // 1. Orientation: person in the TOP-LEFT quadrant of the un-mirrored frame → display-space mass
  //    should be top-left when not mirrored, top-right when mirrored.
  for (const [name, pos] of Object.entries({ topLeft: { x: 0.25, y: 0.3 }, bottomRight: { x: 0.75, y: 0.75 } })) {
    w3.startSynthetic(pos);
    await settle();
    await w3.run(2); // warm up / flush the previous scene (counts ANALYSED frames, bounded by a deadline)
    const { frame, info, frames } = await w3.run(4);
    results.cases[name] = {
      source: frame ? `${frame.sourceWidth}x${frame.sourceHeight}` : null,
      analysedFrames: frames,
      inferenceSize: sizeOf(info?.inferenceSize),
      hands: frame?.hands.length, face: !!frame?.face, faceCenter: faceCenter(frame),
      timings: timingsOf(frame?.timings),
      maskNative: info?.lastMaskSize, fromGpu: info?.lastMaskFromGpu, flippedY: info?.lastMaskFlippedY, labels: info?.segmentationLabels,
      quadrants: w3.maskQuadrants()?.map(r3), warnings: info?.warnings,
    };
  }

  // 2. Parity across the inference rungs on the SAME 1280×720 scene (720 = no resampling).
  w3.startSynthetic({ x: 0.5, y: 0.5, width: 1280, height: 720 });
  await settle();
  const rungs = {};
  for (const maxHeight of [720, 480, 360]) {
    tracker.setOptions({ inferenceMaxHeight: maxHeight, faceStride: 1 });
    await w3.run(2); // let the new input size take effect and the smoothers settle
    const m = await w3.measure(4);
    rungs[maxHeight] = {
      inferenceSize: sizeOf(m.info?.inferenceSize),
      analysedFrames: m.frames,
      face: !!m.frame?.face,
      faceCenter: faceCenter(m.frame),
      quadrants: w3.maskQuadrants()?.map(r3) ?? null,
      meanTimings: timingsOf(m.mean),
    };
  }
  const ref = rungs[720];
  const deltasVs720 = {};
  for (const h of [480, 360]) {
    const r = rungs[h];
    deltasVs720[h] = {
      faceCenter: ref.faceCenter && r.faceCenter ? [r3(r.faceCenter[0] - ref.faceCenter[0]), r3(r.faceCenter[1] - ref.faceCenter[1])] : null,
      quadrantsMaxAbs: ref.quadrants && r.quadrants ? r3(Math.max(...r.quadrants.map((v, i) => Math.abs(v - ref.quadrants[i])))) : null,
      totalMsRatio: ref.meanTimings && r.meanTimings && ref.meanTimings.totalMs > 0 ? +(r.meanTimings.totalMs / ref.meanTimings.totalMs).toFixed(2) : null,
    };
  }
  results.parity = { source: '1280x720 synthetic person, centred', rungs, deltasVs720 };

  // 3. Face stride at the 720 rung.
  const faceStride = {};
  for (const stride of [1, 3]) {
    tracker.setOptions({ inferenceMaxHeight: 720, faceStride: stride });
    await w3.run(2);
    const m = await w3.measure(6);
    faceStride[stride] = { analysedFrames: m.frames, faceRuns: m.faceRuns, face: !!m.frame?.face, meanFaceMs: +m.mean.faceMs.toFixed(1), meanTotalMs: +m.mean.totalMs.toFixed(1) };
  }
  results.faceStride = faceStride;
  // The reused face is dropped once the last face run is older than smoothingResetMs (500 ms). At
  // 30 fps a stride of 3 spans ~100 ms and the face persists; on SwiftShader one analysed frame takes
  // seconds, so `face` is expectedly null on the skipped frames of the stride-3 case here.
  results.faceStrideNote = 'face: false on stride-3 skipped frames is the 500 ms drop under multi-second SwiftShader frames, not a tracking failure';
  tracker.setOptions({ faceStride: 1 });

  // 4. Optional still photo (never in the repo) with two L-shaped hands and a face: real hand inference.
  if (fixtureDataUrl) {
    await w3.startImage(fixtureDataUrl);
    await new Promise((r) => { const tick = () => (video.readyState >= 2 && video.currentTime > 0.3 ? r() : setTimeout(tick, 50)); tick(); });
    await w3.run(4);
    const { frame, info } = await w3.run(8);
    results.cases.photo = {
      source: frame ? `${frame.sourceWidth}x${frame.sourceHeight}` : null,
      inferenceSize: sizeOf(info?.inferenceSize),
      hands: frame?.hands.map((h) => ({ side: h.side, score: r3(h.score), size: r3(h.size), palm: [r3(h.palmCenter.x), r3(h.palmCenter.y)], index: [r3(h.indexTip.x), r3(h.indexTip.y)], thumb: [r3(h.thumbTip.x), r3(h.thumbTip.y)] })),
      face: frame?.face ? { leftEye: [r3(frame.face.leftEye.x), r3(frame.face.leftEye.y)], rightEye: [r3(frame.face.rightEye.x), r3(frame.face.rightEye.y)], roll: +(frame.face.roll * 180 / Math.PI).toFixed(1), eyeOpen: [+frame.face.eyeOpenLeft.toFixed(2), +frame.face.eyeOpenRight.toFixed(2)], mouthOpen: +frame.face.mouthOpen.toFixed(2), smile: +frame.face.smile.toFixed(2), blendshapes: Object.keys(frame.face.blendshapes).length, transformLen: frame.face.transform?.length ?? 0, box: Object.fromEntries(Object.entries(frame.face.faceBox).map(([k, v]) => [k, r3(v)])) } : null,
      timings: timingsOf(frame?.timings),
      quadrants: w3.maskQuadrants()?.map(r3), maskNative: info?.lastMaskSize, warnings: info?.warnings,
    };
  }
  return results;
}, { delegate, mirrored, fixtureDataUrl });

console.log(JSON.stringify({ delegate, mirrored, ...out }, null, 2));

console.log('\nInference-resolution parity — SwiftShader / sandbox timings (relative comparison only):');
for (const [h, r] of Object.entries(out.parity.rungs)) {
  console.log(`  ${h}: input ${r.inferenceSize ?? 'n/a'} · face centre ${r.faceCenter ? r.faceCenter.join(',') : 'none'} · quadrants ${r.quadrants ? r.quadrants.join(' ') : 'n/a'} · mean total ${r.meanTimings?.totalMs ?? 'n/a'} ms over ${r.analysedFrames} frames`);
}
for (const [h, d] of Object.entries(out.parity.deltasVs720)) {
  console.log(`  Δ ${h} vs 720: face centre ${d.faceCenter ? d.faceCenter.join(',') : 'n/a'} · max |Δ quadrant| ${d.quadrantsMaxAbs ?? 'n/a'} · total-ms ratio ${d.totalMsRatio ?? 'n/a'}`);
}
console.log(`Face stride (720 rung, SwiftShader / sandbox): ${JSON.stringify(out.faceStride)}`);
console.log(`  note: ${out.faceStrideNote}`);

const errs = consoleMsgs.filter((m) => /error|pageerror/i.test(m));
if (errs.length) console.log('console errors:\n' + errs.join('\n'));
await browser.close();
if (devServer) await devServer.close();
