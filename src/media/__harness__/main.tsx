/**
 * W2 dev harness: camera / file source → runtime loop → fps.
 * Run: `npx vite --port 6212 --open /src/media/__harness__/index.html`
 * Not imported by the app. Uses whichever real modules exist (stubs otherwise;
 * the list is shown in the stats panel). Store is a local in-memory copy of the
 * AppState shape so this page does not depend on W1 landing.
 */
import { create } from 'zustand';
import type { AppState, AppStore, FrameSource } from '@/types';
import { DEFAULT_INTERACTION_SETTINGS, DEFAULT_QUALITY, DEFAULT_SCENE, PERSONA_ORDER } from '@/types';
import { createCameraSource, createFileSource, isCameraSource, MediaSourceError } from '@/media';
import { startRuntime, computeCoverFit, type AlterFrameRuntime } from '@/runtime';

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
  fps: 0,
  recorderState: 'idle',
  recorderElapsedMs: 0,
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
const devicesEl = $<HTMLSelectElement>('devices');
const fileInput = $<HTMLInputElement>('file');

let runtime: AlterFrameRuntime | null = null;
let facing: 'user' | 'environment' = 'user';

function setStatus(text: string, level: 'info' | 'error' = 'info'): void {
  statusEl.textContent = text;
  statusEl.dataset['level'] = level;
}

async function useSource(source: FrameSource): Promise<void> {
  if (runtime) {
    await runtime.setSource(source);
  } else {
    runtime = startRuntime({ canvas, store, source });
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
const toggle = (id: string, read: () => boolean, write: (v: boolean) => void, label: string) => {
  const btn = $<HTMLButtonElement>(id);
  const paint = () => {
    btn.setAttribute('aria-pressed', String(read()));
    btn.textContent = `${label}: ${read() ? 'on' : 'off'}`;
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
$('stop').addEventListener('click', () => {
  runtime?.stop();
  runtime = null;
  setStatus('Stopped.');
});
window.addEventListener('keydown', (e) => {
  if (e.key === '1' || e.key === '2' || e.key === '3') store.getState().setScene({ persona: PERSONA_ORDER[Number(e.key) - 1] ?? 'portrait' });
  if (e.key === 'b' || e.key === 'B') store.getState().setScene({ base: store.getState().scene.base === 'live' ? 'comic' : 'live' });
});

function paintStats(): void {
  if (runtime) {
    const s = runtime.getStats();
    const src = runtime.source;
    const fit = computeCoverFit({ width: src.width || 1, height: src.height || 1 }, { width: canvas.clientWidth, height: canvas.clientHeight });
    const st = store.getState();
    statsEl.textContent = [
      `fps ${s.fps.toFixed(1)}  frame ${s.frameMs.toFixed(1)}ms  track ${s.trackingMs.toFixed(1)}ms  render ${s.renderMs.toFixed(1)}ms`,
      `source ${src.kind} ${src.status} ${src.width}×${src.height}  frames ${runtime.frameCount}`,
      `scene ${st.scene.base}/${st.scene.persona}/${st.scene.hudTint}  mirrored ${st.mirrored}  quality ${st.quality.renderScale}/${st.quality.segmentationStride}`,
      `cover-fit scale ${fit.scale.toFixed(3)} visible x ${fit.visible.x.toFixed(2)} w ${fit.visible.w.toFixed(2)} y ${fit.visible.y.toFixed(2)} h ${fit.visible.h.toFixed(2)}`,
      `hands ${runtime.lastTracking?.hands.length ?? 0}  face ${runtime.lastTracking?.face ? 'yes' : 'no'}  window ${runtime.windowOpen ? 'open' : 'closed'}`,
      `stubs: ${runtime.modules.stubbed.length ? runtime.modules.stubbed.join(', ') : 'none'}`,
      runtime.lastError ? `last error: ${runtime.lastError.message}` : '',
    ].join('\n');
  } else {
    statsEl.textContent = 'idle — choose a source';
  }
  requestAnimationFrame(paintStats);
}
paintStats();
setStatus('Choose "Use camera" or open a video file. Frames never leave this device.');
