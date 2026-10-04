/**
 * Capture/perf dev harness (not part of the app bundle).
 *   Manual:    node node_modules/vite/bin/vite.js --port 6219 --host 127.0.0.1
 *              then open http://127.0.0.1:6219/src/capture/__harness__/index.html
 *   Automated: node src/capture/__harness__/run-inspect.mjs  (starts Vite, runs inspect.mjs in headless Chromium, stops Vite)
 *
 * Draws a spinning synthetic scene with distinct edge bands (so aspect crops are verifiable by pixel
 * colour), records it with the real recorder — optionally with a short max-duration cap to demo the
 * self-finalize + pending result — offers PNG/JPEG/WebP snapshots and downloads, and shows the perf
 * monitor + adaptive quality ladder reacting to simulated tracking-heavy or render-heavy frames.
 */
import type { CaptureAspect, RecorderState, SnapshotFormat, SnapshotOptions } from '@/types/capture';
import { DEFAULT_QUALITY, type QualitySettings } from '@/types/render';
import { createRecorder, captureFilename, extensionForMime, download, snapshot, type RecordingResult } from '@/capture';
import { createPerfMonitor, createAdaptivePolicy, stepDown, stepUp } from '@/perf';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLCanvasElement>('stage');
const ctx = stage.getContext('2d')!;
const statusEl = $<HTMLPreElement>('status');
const perfEl = $<HTMLPreElement>('perf');
const downloadsEl = $<HTMLDivElement>('downloads');
const aspectEl = $<HTMLSelectElement>('aspect');
const formatEl = $<HTMLSelectElement>('format');
const qualityEl = $<HTMLInputElement>('quality');
const maxDurationEl = $<HTMLInputElement>('maxDuration');
const recordBtn = $<HTMLButtonElement>('record');
const snapBtn = $<HTMLButtonElement>('snapshot');
const loadEl = $<HTMLInputElement>('load');
const renderLoadEl = $<HTMLInputElement>('renderLoad');
const adaptiveEl = $<HTMLInputElement>('adaptive');

/** Edge-band colours: left = red, right = blue, top = green, bottom = yellow; centre = dark grey. */
export const BANDS = { left: '#e02020', right: '#2040e0', top: '#20c040', bottom: '#e0c020', centre: '#303036' } as const;

let frame = 0;
let recorderState: RecorderState = 'idle';
/** Every `onStateChange` value since page load (inspect.mjs checks the self-finalize sequence). */
const stateLog: RecorderState[] = [];
const recorder = createRecorder(() => stage, {
  onStateChange: (s) => {
    recorderState = s;
    stateLog.push(s);
    refreshRecordButton(s);
  },
});
const monitor = createPerfMonitor();
const policy = createAdaptivePolicy();
let quality: QualitySettings = { ...DEFAULT_QUALITY };
let lastResult: { mime: string; size: number; durationMs: number } | null = null;
let lastError: string | null = null;

/** Label reflects the recorder: Record → Stop → Finalizing… → Collect (self-finalized result waiting) → Record. */
function refreshRecordButton(s: RecorderState) {
  recordBtn.textContent = s === 'recording' ? 'Stop' : s === 'finalizing' ? 'Finalizing…' : recorder.hasPendingResult ? 'Collect' : 'Record';
  recordBtn.dataset.recording = String(s === 'recording');
}

/** Number of `stepUp` moves from `q` back to full quality (0 = default quality). */
function ladderDepth(q: QualitySettings): number {
  let depth = 0;
  for (let cur = stepUp(q); cur; cur = stepUp(cur)) depth++;
  return depth;
}

function drawScene(t: number) {
  const { width: w, height: h } = stage;
  ctx.fillStyle = BANDS.centre;
  ctx.fillRect(0, 0, w, h);
  const band = Math.round(w * 0.1);
  ctx.fillStyle = BANDS.left;
  ctx.fillRect(0, 0, band, h);
  ctx.fillStyle = BANDS.right;
  ctx.fillRect(w - band, 0, band, h);
  const vband = Math.round(h * 0.1);
  ctx.fillStyle = BANDS.top;
  ctx.fillRect(band, 0, w - 2 * band, vband);
  ctx.fillStyle = BANDS.bottom;
  ctx.fillRect(band, h - vband, w - 2 * band, vband);
  // Spinning square in the centre, hue cycles so consecutive frames differ (encoder gets motion).
  // Side 0.35·h: its half-diagonal (≈ 0.247·h) stays clear of the 9:16 crop's half-width (0.28·h), so the
  // edge pixels inspect.mjs samples at mid-height are always the centre grey, whatever the rotation.
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(t / 700);
  ctx.fillStyle = `hsl(${(t / 20) % 360} 80% 60%)`;
  ctx.fillRect(-h * 0.175, -h * 0.175, h * 0.35, h * 0.35);
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.font = `${Math.round(h * 0.05)}px system-ui`;
  ctx.textBaseline = 'top';
  ctx.fillText(
    `frame ${frame}  t ${(t / 1000).toFixed(1)}s  scale ${quality.renderScale}  seg ${quality.segmentationStride}  inf ${quality.inferenceMaxHeight}  face ${quality.faceStride}`,
    band + 12,
    vband + 12,
  );
}

function busyWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* simulate a heavy phase */
  }
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function loop(t: number) {
  const f0 = performance.now();
  frame++;
  if (loadEl.checked) busyWait(60); // counted as tracking time
  const t1 = performance.now();
  drawScene(t);
  if (renderLoadEl.checked) busyWait(60); // counted as render time (drives the cost-aware branch)
  const t2 = performance.now();
  monitor.sample({ frameMs: t2 - f0, trackingMs: t1 - f0, renderMs: t2 - t1 });
  if (adaptiveEl.checked) {
    const next = policy.evaluate(monitor.recent(5000), quality);
    if (next) quality = next;
  }
  if (frame % 10 === 0) {
    statusEl.textContent =
      `${recorderState}  ${fmt(recorder.elapsedMs)}` +
      (recorder.hasPendingResult ? '\nfinished on its own (max duration) — press Collect to save it' : '') +
      (lastError ? `\nerror: ${lastError}` : '') +
      (lastResult ? `\nlast: ${lastResult.mime}  ${(lastResult.size / 1024).toFixed(0)} kB  ${(lastResult.durationMs / 1000).toFixed(1)} s` : '');
    perfEl.textContent =
      `fps ${monitor.fps().toFixed(1)}\nladder depth ${ladderDepth(quality)}\nrenderScale ${quality.renderScale}\n` +
      `segmentationStride ${quality.segmentationStride}\ninferenceMaxHeight ${quality.inferenceMaxHeight}\nfaceStride ${quality.faceStride}\n` +
      `samples(5s) ${monitor.recent(5000).length}`;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function addDownload(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.className = 'dl';
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.textContent = `⬇ ${name} (${(blob.size / 1024).toFixed(0)} kB)`;
  downloadsEl.prepend(a);
}

function saveRecording(r: RecordingResult) {
  lastResult = { mime: r.mime, size: r.blob.size, durationMs: r.durationMs };
  const name = captureFilename(extensionForMime(r.mime));
  addDownload(r.blob, name);
  download(r.blob, name);
}

function snapshotOptions(): SnapshotOptions {
  const format = formatEl.value as SnapshotFormat;
  return format === 'png' ? { format } : { format, quality: Number(qualityEl.value) };
}

async function toggleRecord() {
  lastError = null;
  try {
    if (recorder.hasPendingResult || recorder.state === 'recording') {
      saveRecording(await recorder.stop());
    } else if (recorder.state === 'idle') {
      await recorder.start({ aspect: aspectEl.value as CaptureAspect, maxDurationMs: Number(maxDurationEl.value) });
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
  refreshRecordButton(recorder.state);
}

async function takeSnapshot() {
  lastError = null;
  try {
    const blob = await snapshot(stage, aspectEl.value as CaptureAspect, snapshotOptions());
    // The Blob's type is the format the browser really produced (PNG after a fallback).
    const name = captureFilename(extensionForMime(blob.type));
    addDownload(blob, name);
    download(blob, name);
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
}

recordBtn.addEventListener('click', () => void toggleRecord());
snapBtn.addEventListener('click', () => void takeSnapshot());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Automation hook used by `inspect.mjs` (Playwright). */
const harness = {
  recorder,
  monitor,
  stateLog,
  getQuality: () => quality,
  ladderDepth: (q?: QualitySettings) => ladderDepth(q ?? quality),
  /** `steps` ladder rungs down from `q` (null when the ladder runs out) — the expected result of tracking-heavy load. */
  ladderFrom(q: QualitySettings, steps: number): QualitySettings | null {
    let cur: QualitySettings | null = q;
    for (let i = 0; i < steps && cur; i++) cur = stepDown(cur);
    return cur;
  },
  async record(aspect: CaptureAspect, ms: number) {
    await recorder.start({ aspect });
    await sleep(ms);
    const r = await recorder.stop();
    return { mime: r.mime, size: r.blob.size, durationMs: r.durationMs, blob: r.blob };
  },
  /** Record with a hard cap and let it finalize on its own; probe the pending-result semantics before and after collecting. */
  async recordCapped(aspect: CaptureAspect, maxDurationMs: number, timeoutMs = 10_000) {
    const from = stateLog.length;
    await recorder.start({ aspect, maxDurationMs });
    const t0 = performance.now();
    while (recorder.state !== 'idle' && performance.now() - t0 < timeoutMs) await sleep(50);
    const finishedAfterMs = performance.now() - t0;
    const pendingBeforeCollect = recorder.hasPendingResult === true;
    let startWhilePending: string;
    try {
      await recorder.start({ aspect });
      startWhilePending = 'resolved?!';
    } catch (e) {
      startWhilePending = errorText(e);
    }
    const r = await recorder.stop();
    const pendingAfterCollect = recorder.hasPendingResult === true;
    let secondStop: string;
    try {
      await recorder.stop();
      secondStop = 'resolved?!';
    } catch (e) {
      secondStop = errorText(e);
    }
    return {
      states: stateLog.slice(from),
      finishedAfterMs,
      pendingBeforeCollect,
      startWhilePending,
      pendingAfterCollect,
      secondStop,
      mime: r.mime,
      size: r.blob.size,
      durationMs: r.durationMs,
      blob: r.blob,
    };
  },
  snapshot: (aspect: CaptureAspect, opts?: SnapshotOptions) => snapshot(stage, aspect, opts),
  /** Simulated load: `tracking` busy-waits before drawing, `render` busy-waits after drawing. */
  setLoad: (on: boolean, phase: 'tracking' | 'render' = 'tracking') => {
    loadEl.checked = on && phase === 'tracking';
    renderLoadEl.checked = on && phase === 'render';
  },
};
declare global {
  interface Window { __captureHarness?: typeof harness }
}
window.__captureHarness = harness;
