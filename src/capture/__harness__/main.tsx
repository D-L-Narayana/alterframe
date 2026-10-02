/**
 * W9 dev harness (not part of the app bundle). Run:  npx vite --port 6219
 * then open http://localhost:6219/src/capture/__harness__/index.html
 *
 * Draws a spinning synthetic scene with distinct edge bands (so aspect crops are verifiable
 * by pixel colour), records it with the real recorder, offers downloads, and shows the perf
 * monitor + adaptive quality policy reacting to a simulated heavy frame.
 */
import type { CaptureAspect, RecorderState } from '@/types/capture';
import { DEFAULT_QUALITY, type QualitySettings } from '@/types/render';
import { createRecorder, captureFilename, extensionForMime, download, snapshot } from '@/capture';
import { createPerfMonitor, createAdaptivePolicy } from '@/perf';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLCanvasElement>('stage');
const ctx = stage.getContext('2d')!;
const statusEl = $<HTMLPreElement>('status');
const perfEl = $<HTMLPreElement>('perf');
const downloadsEl = $<HTMLDivElement>('downloads');
const aspectEl = $<HTMLSelectElement>('aspect');
const recordBtn = $<HTMLButtonElement>('record');
const snapBtn = $<HTMLButtonElement>('snapshot');
const loadEl = $<HTMLInputElement>('load');
const adaptiveEl = $<HTMLInputElement>('adaptive');

/** Edge-band colours: left = red, right = blue, top = green, bottom = yellow; centre = dark grey. */
export const BANDS = { left: '#e02020', right: '#2040e0', top: '#20c040', bottom: '#e0c020', centre: '#303036' } as const;

let frame = 0;
let recorderState: RecorderState = 'idle';
const recorder = createRecorder(() => stage, {
  onStateChange: (s) => {
    recorderState = s;
    recordBtn.textContent = s === 'recording' ? 'Stop' : s === 'finalizing' ? 'Finalizing…' : 'Record';
    recordBtn.dataset.recording = String(s === 'recording');
  },
});
const monitor = createPerfMonitor();
const policy = createAdaptivePolicy();
let quality: QualitySettings = { ...DEFAULT_QUALITY };
let lastResult: { mime: string; size: number; durationMs: number } | null = null;
let lastError: string | null = null;

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
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(t / 700);
  ctx.fillStyle = `hsl(${(t / 20) % 360} 80% 60%)`;
  ctx.fillRect(-h * 0.2, -h * 0.2, h * 0.4, h * 0.4);
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.font = `${Math.round(h * 0.05)}px system-ui`;
  ctx.textBaseline = 'top';
  ctx.fillText(`frame ${frame}  t ${(t / 1000).toFixed(1)}s  scale ${quality.renderScale}  stride ${quality.segmentationStride}`, band + 12, vband + 12);
}

function busyWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* simulate heavy tracking */
  }
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function loop(t: number) {
  const f0 = performance.now();
  frame++;
  if (loadEl.checked) busyWait(60);
  const t1 = performance.now();
  drawScene(t);
  const t2 = performance.now();
  monitor.sample({ frameMs: t2 - f0, trackingMs: t1 - f0, renderMs: t2 - t1 });
  if (adaptiveEl.checked) {
    const next = policy.evaluate(monitor.recent(5000), quality);
    if (next) quality = next;
  }
  if (frame % 10 === 0) {
    statusEl.textContent = `${recorderState}  ${fmt(recorder.elapsedMs)}` + (lastError ? `\nerror: ${lastError}` : '') +
      (lastResult ? `\nlast: ${lastResult.mime}  ${(lastResult.size / 1024).toFixed(0)} kB  ${(lastResult.durationMs / 1000).toFixed(1)} s` : '');
    perfEl.textContent = `fps ${monitor.fps().toFixed(1)}\nrenderScale ${quality.renderScale}\nsegmentationStride ${quality.segmentationStride}\nsamples(5s) ${monitor.recent(5000).length}`;
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

async function toggleRecord() {
  lastError = null;
  try {
    if (recorder.state === 'idle') {
      await recorder.start({ aspect: aspectEl.value as CaptureAspect });
    } else if (recorder.state === 'recording') {
      const r = await recorder.stop();
      lastResult = { mime: r.mime, size: r.blob.size, durationMs: r.durationMs };
      const name = captureFilename(extensionForMime(r.mime));
      addDownload(r.blob, name);
      download(r.blob, name);
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
}

async function takeSnapshot() {
  lastError = null;
  try {
    const blob = await snapshot(stage, aspectEl.value as CaptureAspect);
    const name = captureFilename('png');
    addDownload(blob, name);
    download(blob, name);
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
}

recordBtn.addEventListener('click', () => void toggleRecord());
snapBtn.addEventListener('click', () => void takeSnapshot());

/** Automation hook used by `inspect.mjs` (Playwright). */
const harness = {
  recorder,
  monitor,
  getQuality: () => quality,
  async record(aspect: CaptureAspect, ms: number) {
    await recorder.start({ aspect });
    await new Promise((r) => setTimeout(r, ms));
    const r = await recorder.stop();
    return { mime: r.mime, size: r.blob.size, durationMs: r.durationMs, blob: r.blob };
  },
  snapshot: (aspect: CaptureAspect) => snapshot(stage, aspect),
  setLoad: (on: boolean) => {
    loadEl.checked = on;
  },
};
declare global {
  interface Window { __captureHarness?: typeof harness }
}
window.__captureHarness = harness;
