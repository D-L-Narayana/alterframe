/**
 * Media dev harness: camera / file source → runtime loop → stats, transport, diagnostics.
 * Run: `npx vite --port 6212 --open /src/media/__harness__/index.html`
 * Not imported by the app. Uses the real modules through `startRuntime` (the tracker is the lazy
 * wrapper so the MediaPipe chunk status is visible). Store is a local in-memory copy of the
 * AppState shape so this page does not depend on the app shell.
 */
import { create } from 'zustand';
import type { AppState, AppStore, FrameSource, TransportState } from '@/types';
import { DEFAULT_CAPTURE_SETTINGS, DEFAULT_INTERACTION_SETTINGS, DEFAULT_LOOK, DEFAULT_QUALITY, DEFAULT_SCENE, PERSONA_ORDER } from '@/types';
import { createCameraSource, createFileSource, isCameraSource, MediaSourceError } from '@/media';
import { startRuntime, computeCoverFit, createLazyTracker, type AlterFrameRuntime, type LazyTracker } from '@/runtime';

const store: AppStore = create<AppState>()((set, get) => ({
  mirrored: true,
  hudEnabled: true,
  hudTintAuto: true,
  showFps: true,
  debugLandmarks: false,
  interaction: { ...DEFAULT_INTERACTION_SETTINGS },
  quality: { ...DEFAULT_QUALITY },
  adaptiveQuality: true,
  reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  fitMode: 'cover',
  thinStripGlitch: false,
  look: { ...DEFAULT_LOOK },
  capture: { ...DEFAULT_CAPTURE_SETTINGS },
  setSettings: (partial) => set(partial),
  scene: { ...DEFAULT_SCENE },
  directorRunning: false,
  setScene: (partial) => {
    const scene = { ...get().scene, ...partial };
    if (get().hudTintAuto) scene.hudTint = scene.base === 'comic' ? 'red' : 'white';
    set({ scene });
  },
  cyclePersona: () => {
    const i = PERSONA_ORDER.indexOf(get().scene.persona);
    get().setScene({ persona: PERSONA_ORDER[(i + 1) % PERSONA_ORDER.length] ?? 'portrait' });
  },
  setDirectorRunning: (v) => set({ directorRunning: v }),
  sourceKind: 'camera',
  sourceStatus: 'idle',
  sourceError: null,
  cameraDeviceId: null,
  trackerReady: false,
  trackerProgress: 0,
  trackerError: null,
  windowOpen: false,
  contextLost: false,
  fps: 0,
  recorderState: 'idle',
  recorderElapsedMs: 0,
  countdown: null,
  transport: null,
  captureRequest: null,
  setSession: (partial) => set(partial),
}));

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const canvas = $<HTMLCanvasElement>('stage');
const statusEl = $<HTMLDivElement>('status');
const statsEl = $<HTMLPreElement>('stats');
const diagEl = $<HTMLPreElement>('diag');
const devicesEl = $<HTMLSelectElement>('devices');
const fileInput = $<HTMLInputElement>('file');
const transportNav = $<HTMLElement>('transport');
const playBtn = $<HTMLButtonElement>('play');
const seekEl = $<HTMLInputElement>('seek');
const timeEl = $<HTMLSpanElement>('time');
const loopBtn = $<HTMLButtonElement>('loop');
const chunkEl = $<HTMLSpanElement>('chunk');
const progressEl = $<HTMLProgressElement>('progress');
const trackerStatusEl = $<HTMLSpanElement>('trackerStatus');
const retryBtn = $<HTMLButtonElement>('retry');

let runtime: AlterFrameRuntime | null = null;
let lazy: LazyTracker | null = null;
let facing: 'user' | 'environment' = 'user';
let showDiag = true;

function setStatus(text: string, level: 'info' | 'error' = 'info'): void {
  statusEl.textContent = text;
  statusEl.dataset['level'] = level;
}

const mmss = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

async function useSource(source: FrameSource): Promise<void> {
  if (runtime) {
    await runtime.setSource(source);
  } else {
    runtime = startRuntime(
      { canvas, store, source },
      // Same lazy wrapper the app uses, kept in a local so the chunk status can be shown.
      { factories: { createTracker: (o, p) => (lazy = createLazyTracker(o, p)) } },
    );
    const rt = runtime;
    void rt.trackerReady.then(() => setStatus(rt.trackerError ? `Tracker failed: ${rt.trackerError}` : 'Tracker ready.'));
    await runtime.ready;
  }
  // The runtime starts idle sources itself; start() is idempotent, so awaiting it here just waits for the prompt.
  try {
    await source.start();
  } catch {
    /* status/error carried by the source */
  }
  if (source.status !== 'ready') {
    const err = (source as FrameSource & { error?: string | null }).error ?? 'Source failed to start.';
    setStatus(err, 'error');
    return;
  }
  setStatus(`${source.kind} ready — ${source.width}×${source.height}${runtime.trackerError ? ` (tracker: ${runtime.trackerError})` : ''}`);
  if (isCameraSource(source)) {
    const list = await source.listDevices();
    devicesEl.replaceChildren(
      ...list.map((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Camera ${i + 1}`;
        o.selected = d.deviceId === source.deviceId;
        return o;
      }),
    );
  }
}

async function startCamera(deviceId?: string): Promise<void> {
  setStatus('Requesting camera…');
  const source = createCameraSource(deviceId ? { deviceId } : { facingMode: facing });
  try {
    await useSource(source);
  } catch (e) {
    setStatus(e instanceof MediaSourceError ? e.message : String(e), 'error');
  }
}

$('cam').addEventListener('click', () => void startCamera());
devicesEl.addEventListener('change', () => void startCamera(devicesEl.value));
$('flip').addEventListener('click', () => {
  facing = facing === 'user' ? 'environment' : 'user';
  void startCamera();
});
$('open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  setStatus(`Opening ${file.name}…`);
  void useSource(createFileSource(file)).catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e), 'error'));
});
const toggle = (id: string, read: () => boolean, write: (v: boolean) => void, label: string, on = 'on', off = 'off') => {
  const btn = $<HTMLButtonElement>(id);
  const paint = () => {
    btn.setAttribute('aria-pressed', String(read()));
    btn.textContent = `${label}: ${read() ? on : off}`;
  };
  btn.addEventListener('click', () => {
    write(!read());
    paint();
  });
  paint();
};
toggle('mirror', () => store.getState().mirrored, (v) => store.getState().setSettings({ mirrored: v }), 'Mirror');
toggle('hud', () => store.getState().hudEnabled, (v) => store.getState().setSettings({ hudEnabled: v }), 'HUD');
toggle('director', () => store.getState().directorRunning, (v) => store.getState().setDirectorRunning(v), 'Director');
toggle('fit', () => store.getState().fitMode === 'contain', (v) => store.getState().setSettings({ fitMode: v ? 'contain' : 'cover' }), 'Fit', 'contain', 'cover');
toggle(
  'dwell',
  () => store.getState().capture.dwellAction !== 'off',
  (v) => store.getState().setSettings({ capture: { ...store.getState().capture, dwellAction: v ? 'snapshot' : 'off' }, interaction: { ...store.getState().interaction, dwellMs: v ? 1500 : 0 } }),
  'Hold still',
  'snapshot',
  'off',
);
toggle('diagToggle', () => showDiag, (v) => {
  showDiag = v;
  diagEl.hidden = !v;
}, 'Diagnostics');
$('render').addEventListener('click', () => runtime?.requestRender());
retryBtn.addEventListener('click', () => void runtime?.retryTracker());
$('stop').addEventListener('click', () => {
  runtime?.stop();
  runtime = null;
  lazy = null;
  setStatus('Stopped.');
});
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const st = store.getState();
  if (e.key === '1' || e.key === '2' || e.key === '3') st.setScene({ persona: PERSONA_ORDER[Number(e.key) - 1] ?? 'portrait' });
  if (e.key === 'b' || e.key === 'B') st.setScene({ base: st.scene.base === 'live' ? 'comic' : 'live' });
  const tr = runtime?.source.transport;
  if (!tr) return;
  if (e.key === 'p' || e.key === 'P') void (tr.paused ? tr.play() : tr.pause());
  if (e.key === '[') tr.seek(tr.currentTime - 1);
  if (e.key === ']') tr.seek(tr.currentTime + 1);
  if (e.key === 'l' || e.key === 'L') tr.setLoop(!tr.loop);
});

// ------------------------------------------------------------- transport UI
playBtn.addEventListener('click', () => {
  const tr = runtime?.source.transport;
  if (!tr) return;
  void (tr.paused ? tr.play() : tr.pause());
});
seekEl.addEventListener('input', () => runtime?.source.transport?.seek(Number(seekEl.value)));
loopBtn.addEventListener('click', () => {
  const tr = runtime?.source.transport;
  tr?.setLoop(!tr.loop);
});

function paintTransport(t: TransportState | null): void {
  transportNav.hidden = t === null;
  if (!t) return;
  playBtn.textContent = t.paused ? 'Play' : 'Pause';
  const dur = Number.isFinite(t.duration) ? t.duration : 0;
  seekEl.max = String(dur);
  if (document.activeElement !== seekEl) seekEl.value = String(Math.min(dur, t.currentTime));
  seekEl.setAttribute('aria-valuetext', mmss(t.currentTime));
  timeEl.textContent = `${mmss(t.currentTime)} / ${mmss(t.duration)}`;
  loopBtn.setAttribute('aria-checked', String(t.loop));
  loopBtn.textContent = `Loop: ${t.loop ? 'on' : 'off'}`;
}

function paintTracker(s: AppState): void {
  const pct = Math.round(s.trackerProgress * 100);
  progressEl.value = pct;
  chunkEl.textContent = `tracking chunk: ${lazy ? (lazy.loaded ? 'loaded' : 'importing…') : 'not requested'}`;
  trackerStatusEl.textContent = s.trackerReady ? 'tracker: ready' : s.trackerError ? `tracker: failed — ${s.trackerError}` : `tracker: loading ${pct}%`;
  retryBtn.hidden = s.trackerError === null;
}

store.subscribe((s, prev) => {
  if (s.transport !== prev.transport) paintTransport(s.transport);
  if (s.trackerProgress !== prev.trackerProgress || s.trackerReady !== prev.trackerReady || s.trackerError !== prev.trackerError) paintTracker(s);
});
paintTransport(store.getState().transport);
paintTracker(store.getState());

// ---------------------------------------------------------------- readouts
function paintStats(): void {
  if (runtime) {
    const s = runtime.getStats();
    const src = runtime.source;
    const fit = computeCoverFit({ width: src.width || 1, height: src.height || 1 }, { width: canvas.clientWidth, height: canvas.clientHeight });
    const st = store.getState();
    statsEl.textContent = [
      `fps ${s.fps.toFixed(1)}  frame ${s.frameMs.toFixed(1)}ms  track ${s.trackingMs.toFixed(1)}ms  render ${s.renderMs.toFixed(1)}ms`,
      `source ${src.kind} ${src.status} ${src.width}×${src.height}  frames ${runtime.frameCount}`,
      `scene ${st.scene.base}/${st.scene.persona}/${st.scene.hudTint}  mirrored ${st.mirrored}  fit ${st.fitMode}`,
      `quality ${st.quality.renderScale}/${st.quality.segmentationStride}/${st.quality.inferenceMaxHeight}p/face×${st.quality.faceStride}`,
      `cover-fit scale ${fit.scale.toFixed(3)} visible x ${fit.visible.x.toFixed(2)} w ${fit.visible.w.toFixed(2)} y ${fit.visible.y.toFixed(2)} h ${fit.visible.h.toFixed(2)}`,
      `hands ${runtime.lastTracking?.hands.length ?? 0}  face ${runtime.lastTracking?.face ? 'yes' : 'no'}  window ${st.windowOpen ? 'open' : 'closed'}  context ${st.contextLost ? 'LOST' : 'ok'}`,
      `captureRequest ${st.captureRequest ? `${st.captureRequest.action}#${st.captureRequest.id}` : 'none'}  stubs: ${runtime.modules.stubbed.length ? runtime.modules.stubbed.join(', ') : 'none'}`,
      runtime.lastError ? `last error: ${runtime.lastError.message}` : '',
    ].join('\n');
  } else {
    statsEl.textContent = 'idle — choose a source';
  }
  requestAnimationFrame(paintStats);
}
paintStats();

// The app polls diagnostics at 2 Hz while its Diagnostics group is visible; mirror that cadence.
setInterval(() => {
  if (!showDiag) return;
  diagEl.textContent = runtime ? JSON.stringify(runtime.getDiagnostics(), null, 2) : '';
}, 500);

// A dwell capture request would be consumed by the app; here just acknowledge and clear it.
store.subscribe((s, prev) => {
  if (s.captureRequest && s.captureRequest !== prev.captureRequest) {
    setStatus(`Hold-still gesture → ${s.captureRequest.action} request #${s.captureRequest.id} (cleared by the harness)`);
    setTimeout(() => store.getState().setSession({ captureRequest: null }), 1000);
  }
});

setStatus('Choose "Use camera" or open a video file. Frames never leave this device.');
