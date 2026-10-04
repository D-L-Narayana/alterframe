/**
 * Dev harness for the tracking module (never imported by the app). Run:
 *   npx vite --port 6213 --open /src/tracking/__harness__/index.html
 * Shows landmarks + mask over a camera or a synthetic input, with live controls for delegate,
 * mirroring, segmentation stride, tracking resolution (inferenceMaxHeight) and face stride, and
 * exposes `window.__w3` for the Playwright verification script (`verify.mjs` in this folder).
 */
import { createTracker } from '../index';
import type { AlterFrameTracker, AlterFrameTrackerOptions } from '../index';
import type { TrackerInfo, TrackingFrame, TrackingTimings } from '../../types/tracking';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const maskCanvas = $<HTMLCanvasElement>('mask');
const logEl = $<HTMLPreElement>('log');
const statusEl = $<HTMLSpanElement>('status');
const progressEl = $<HTMLProgressElement>('progress');
const delegateEl = $<HTMLSelectElement>('delegate');
const mirrorEl = $<HTMLInputElement>('mirror');
const strideEl = $<HTMLInputElement>('stride');
const resEl = $<HTMLSelectElement>('res');
const faceStrideEl = $<HTMLInputElement>('face-stride');

let tracker: AlterFrameTracker | null = null;
let lastFrame: TrackingFrame | null = null;
let raf = 0;
let stream: MediaStream | null = null;
let synthetic: { canvas: HTMLCanvasElement; timer: number } | null = null;

function log(obj: unknown): void {
  logEl.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

const uiInferenceMaxHeight = (): number => Number(resEl.value) || 720;
const uiFaceStride = (): number => Number(faceStrideEl.value) || 1;

async function ensureTracker(extra: Partial<AlterFrameTrackerOptions> = {}): Promise<AlterFrameTracker> {
  if (tracker) { tracker.dispose(); tracker = null; }
  const t = createTracker({
    delegate: delegateEl.value as 'GPU' | 'CPU',
    mirrored: mirrorEl.checked,
    segmentationStride: Number(strideEl.value) || 1,
    inferenceMaxHeight: uiInferenceMaxHeight(),
    faceStride: uiFaceStride(),
    ...extra,
  }, (p) => { progressEl.value = p; statusEl.textContent = `loading ${(p * 100).toFixed(0)} %`; });
  const t0 = performance.now();
  await t.init();
  statusEl.textContent = `ready in ${(performance.now() - t0).toFixed(0)} ms · ${JSON.stringify(t.getInfo().delegates)}`;
  tracker = t;
  return t;
}

function stopInput(): void {
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((tr) => tr.stop());
  stream = null;
  if (synthetic) { clearInterval(synthetic.timer); synthetic = null; }
}

function loop(): void {
  raf = requestAnimationFrame(loop);
  if (!tracker?.ready || video.readyState < 2) return;
  const frame = tracker.update(video, performance.now());
  if (frame === lastFrame) return;
  lastFrame = frame;
  draw(frame);
}

function draw(frame: TrackingFrame): void {
  const w = frame.sourceWidth, h = frame.sourceHeight;
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  video.style.transform = mirrorEl.checked ? 'scaleX(-1)' : '';
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 2;
  for (const hand of frame.hands) {
    ctx.strokeStyle = hand.side === 'left' ? '#3b7bff' : '#ff4fb6';
    ctx.fillStyle = ctx.strokeStyle;
    for (const p of hand.landmarks) { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.beginPath(); ctx.arc(hand.indexTip.x * w, hand.indexTip.y * h, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(hand.thumbTip.x * w, hand.thumbTip.y * h, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(`${hand.side} ${hand.score.toFixed(2)} size ${hand.size.toFixed(2)}`, hand.palmCenter.x * w, hand.palmCenter.y * h);
  }
  const f = frame.face;
  if (f) {
    ctx.fillStyle = '#f5f5f7';
    for (const p of f.landmarks) ctx.fillRect(p.x * w, p.y * h, 1.5, 1.5);
    ctx.strokeStyle = '#ff2b2b';
    ctx.strokeRect(f.faceBox.x * w, f.faceBox.y * h, f.faceBox.w * w, f.faceBox.h * h);
    ctx.fillStyle = '#3b7bff'; ctx.beginPath(); ctx.arc(f.leftEye.x * w, f.leftEye.y * h, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff4fb6'; ctx.beginPath(); ctx.arc(f.rightEye.x * w, f.rightEye.y * h, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f5f5f7';
    ctx.fillText(`roll ${(f.roll * 180 / Math.PI).toFixed(1)}° eyes ${f.eyeOpenLeft.toFixed(2)}/${f.eyeOpenRight.toFixed(2)} mouth ${f.mouthOpen.toFixed(2)} smile ${f.smile.toFixed(2)}`, f.faceBox.x * w, (f.faceBox.y + f.faceBox.h) * h + 14);
  }
  const seg = frame.segmentation;
  if (seg) {
    if (maskCanvas.width !== seg.width) { maskCanvas.width = seg.width; maskCanvas.height = seg.height; }
    const mctx = maskCanvas.getContext('2d')!;
    const img = mctx.createImageData(seg.width, seg.height);
    for (let i = 0; i < seg.data.length; i++) {
      const v = Math.round(seg.data[i]! * 255);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    mctx.putImageData(img, 0, 0);
  }
  const info = tracker?.getInfo();
  log({
    t: Math.round(frame.t), source: `${w}×${h}`,
    inference: info?.inferenceSize ? `${info.inferenceSize.width}×${info.inferenceSize.height}` : null,
    faceStride: uiFaceStride(),
    timings: Object.fromEntries(Object.entries(frame.timings).map(([k, v]) => [k, +v.toFixed(2)])),
    hands: frame.hands.map((hd) => ({ side: hd.side, score: +hd.score.toFixed(2), index: [+hd.indexTip.x.toFixed(3), +hd.indexTip.y.toFixed(3)], thumb: [+hd.thumbTip.x.toFixed(3), +hd.thumbTip.y.toFixed(3)] })),
    face: f ? { roll: +(f.roll * 180 / Math.PI).toFixed(1), leftEye: [+f.leftEye.x.toFixed(3), +f.leftEye.y.toFixed(3)], rightEye: [+f.rightEye.x.toFixed(3), +f.rightEye.y.toFixed(3)], eyeOpen: [+f.eyeOpenLeft.toFixed(2), +f.eyeOpenRight.toFixed(2)], mouthOpen: +f.mouthOpen.toFixed(2), smile: +f.smile.toFixed(2), blendshapes: Object.keys(f.blendshapes).length, transform: !!f.transform } : null,
    segmentation: seg ? { size: `${seg.width}×${seg.height}`, native: info?.lastMaskSize, fromGpu: info?.lastMaskFromGpu, flippedY: info?.lastMaskFlippedY, labels: info?.segmentationLabels } : null,
    delegates: info?.delegates, warnings: info?.warnings,
  });
}

/**
 * Still-image input: any image URL / data URL (e.g. a local test photo chosen via the file picker,
 * or passed by verify.mjs as a data URL). No image fixture ships in the repository — photoreal
 * likenesses, even synthetic ones, stay outside the public tree. The image is drawn into a canvas and
 * piped through a MediaStream so `video.currentTime` advances like a real camera.
 */
async function startImage(url: string): Promise<void> {
  stopInput();
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  const paint = (): void => { ctx.drawImage(img, 0, 0); };
  paint();
  const timer = window.setInterval(paint, 33);
  const s = canvas.captureStream(30);
  stream = s;
  video.srcObject = s;
  await video.play();
  synthetic = { canvas, timer };
}

/**
 * Synthetic input: a plain scene with a "person" (skin-tone head, dark torso) whose position and
 * frame size can be set programmatically, piped through a MediaStream so `video.currentTime`
 * advances. The scene is designed at 640×360 and scales with the requested height, so a
 * 1280×720 frame shows the same picture at twice the pixel count (the inference-resolution rungs
 * only bite on sources taller than 480 / 360).
 */
function startSynthetic(opts: { x?: number; y?: number; width?: number; height?: number } = {}): void {
  stopInput();
  const canvas = document.createElement('canvas');
  canvas.width = opts.width ?? 640; canvas.height = opts.height ?? 360;
  const s = canvas.height / 360;
  const ctx = canvas.getContext('2d')!;
  const paint = (): void => {
    const cx = (opts.x ?? 0.5) * canvas.width, cy = (opts.y ?? 0.55) * canvas.height;
    ctx.fillStyle = '#c9d2dc'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2b2f3a'; ctx.beginPath(); ctx.ellipse(cx, cy + 150 * s, 130 * s, 110 * s, 0, 0, Math.PI * 2); ctx.fill(); // torso
    ctx.fillStyle = '#e0b094'; ctx.beginPath(); ctx.ellipse(cx, cy, 55 * s, 70 * s, 0, 0, Math.PI * 2); ctx.fill();              // head
    ctx.fillStyle = '#1a1a1a'; ctx.beginPath(); ctx.ellipse(cx, cy - 55 * s, 60 * s, 30 * s, 0, 0, Math.PI * 2); ctx.fill();    // hair
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(cx - 20 * s, cy - 10 * s, 5 * s, 0, Math.PI * 2); ctx.arc(cx + 20 * s, cy - 10 * s, 5 * s, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8a4a3a'; ctx.lineWidth = 3 * s; ctx.beginPath(); ctx.arc(cx, cy + 25 * s, 15 * s, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
  };
  paint();
  const timer = window.setInterval(paint, 33);
  const ms = canvas.captureStream(30);
  stream = ms;
  video.srcObject = ms;
  void video.play();
  synthetic = { canvas, timer };
}

async function startCamera(): Promise<void> {
  stopInput();
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  video.srcObject = stream;
  await video.play();
}

$('btn-camera').addEventListener('click', async () => {
  await ensureTracker();
  await startCamera();
  loop();
});
($('file-image') as HTMLInputElement).addEventListener('change', async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await ensureTracker();
  const url = URL.createObjectURL(file);
  try {
    await startImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  loop();
});
$('btn-synthetic').addEventListener('click', async () => {
  await ensureTracker();
  startSynthetic();
  loop();
});
mirrorEl.addEventListener('change', () => tracker?.setOptions({ mirrored: mirrorEl.checked }));
strideEl.addEventListener('change', () => tracker?.setOptions({ segmentationStride: Number(strideEl.value) || 1 }));
delegateEl.addEventListener('change', () => tracker?.setOptions({ delegate: delegateEl.value as 'GPU' | 'CPU' }));
// Both apply live on the next analysed frame (no task rebuild).
resEl.addEventListener('change', () => tracker?.setOptions({ inferenceMaxHeight: uiInferenceMaxHeight() }));
faceStrideEl.addEventListener('change', () => tracker?.setOptions({ faceStride: uiFaceStride() }));

/**
 * Advance the loop until `n` NEW analysed frames have been produced or `timeoutMs` has elapsed.
 * Counting rAF ticks instead would be wrong here: an unchanged decoded frame returns the cached
 * result instantly, and after a multi-second (SwiftShader) inference the capture stream needs a
 * moment before it delivers the next frame — ten ticks can pass in ~170 ms with nothing analysed.
 */
async function collect(n: number, timeoutMs: number, onFrame?: (f: TrackingFrame) => void): Promise<number> {
  cancelAnimationFrame(raf);
  const deadline = performance.now() + timeoutMs;
  let frames = 0;
  while (frames < n && performance.now() < deadline) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (!tracker?.ready || video.readyState < 2) continue;
    const f = tracker.update(video, performance.now());
    if (f === lastFrame) continue;
    lastFrame = f;
    draw(f);
    frames++;
    onFrame?.(f);
  }
  return frames;
}

/** Hooks for the Playwright verification script. */
declare global { interface Window { __w3?: W3Hooks } }
interface Measurement {
  /** Analysed frames (cached repeats of an unchanged decoded frame are not counted). */
  frames: number;
  /** Analysed frames on which the face landmarker actually ran (faceMs > 0). */
  faceRuns: number;
  /** Mean timings over the analysed frames. */
  mean: TrackingTimings;
  frame: TrackingFrame | null;
  info: TrackerInfo | null;
}
interface W3Hooks {
  ensureTracker: typeof ensureTracker;
  startSynthetic: typeof startSynthetic;
  startImage: typeof startImage;
  /** Analyse `n` new frames of the current video (or stop at `timeoutMs`) and return the last frame + info. */
  run(n: number, timeoutMs?: number): Promise<{ frame: TrackingFrame | null; info: TrackerInfo | null; frames: number }>;
  /** Analyse `n` new frames (or stop at `timeoutMs`) and average their timings. */
  measure(n: number, timeoutMs?: number): Promise<Measurement>;
  /** Mean mask value per quadrant [TL, TR, BL, BR] of the current segmentation (display space). */
  maskQuadrants(): number[] | null;
  getTracker(): AlterFrameTracker | null;
}
window.__w3 = {
  ensureTracker,
  startSynthetic,
  startImage,
  async run(n, timeoutMs = 90_000) {
    const frames = await collect(n, timeoutMs);
    return { frame: lastFrame, info: tracker?.getInfo() ?? null, frames };
  },
  async measure(n, timeoutMs = 90_000) {
    const sum: TrackingTimings = { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 };
    let faceRuns = 0;
    const frames = await collect(n, timeoutMs, (f) => {
      sum.handsMs += f.timings.handsMs; sum.faceMs += f.timings.faceMs; sum.segMs += f.timings.segMs; sum.totalMs += f.timings.totalMs;
      if (f.timings.faceMs > 0) faceRuns++;
    });
    const mean: TrackingTimings = frames > 0
      ? { handsMs: sum.handsMs / frames, faceMs: sum.faceMs / frames, segMs: sum.segMs / frames, totalMs: sum.totalMs / frames }
      : sum;
    return { frames, faceRuns, mean, frame: lastFrame, info: tracker?.getInfo() ?? null };
  },
  maskQuadrants() {
    const seg = lastFrame?.segmentation;
    if (!seg) return null;
    const sums = [0, 0, 0, 0];
    const half = seg.width / 2;
    for (let y = 0; y < seg.height; y++) for (let x = 0; x < seg.width; x++) {
      const q = (y < half ? 0 : 2) + (x < half ? 0 : 1);
      sums[q]! += seg.data[y * seg.width + x]!;
    }
    return sums.map((s) => s / (half * half));
  },
  getTracker: () => tracker,
};
