/**
 * Runtime loop. `startRuntime(deps)` wires FrameSource → Tracker → Interaction → Director →
 * PersonaLayer → HUD → Renderer → Perf, once per presented video frame, and returns a
 * `RuntimeHandle`.
 *
 * Coordinate contract (see ./viewport.ts): tracker output and overlay canvases live in the
 * INTRINSIC video frame; the renderer performs the single cover/contain fit into the canvas. The
 * runtime passes `videoWidth/videoHeight` consistently to tracker, persona, HUD and renderer and
 * never remaps.
 *
 * The store is the single source of truth: settings, scene and countdown flow in; the loop
 * publishes its session fields (tracker progress/error, windowOpen, contextLost, transport,
 * captureRequest, fps, recorder state) through `setSession`, writing only keys whose value changed.
 */
import type {
  AppState,
  CaptureAspect,
  FrameSource,
  InteractionEvent,
  QualitySettings,
  Renderer,
  RuntimeDeps,
  RuntimeDiagnostics,
  RuntimeHandle,
  RuntimeStats,
  SceneState,
  SessionSlice,
  Size,
  SnapshotOptions,
  StylePreset,
  TrackerOptions,
  TrackingFrame,
  TransportState,
} from '@/types';
import { isObservableSource } from '@/media/sourceBase';
import { hasTransportEvents } from '@/media/fileSource';
import { resolveFactories, type FactoryName, type RuntimeFactories } from './factories';
import { computeGlitch } from './glitch';
import { hudCountdown } from './countdown';
import { overlaySizeFor } from './viewport';
import { DEV_BRIDGE_ENABLED, devWarn, installDevBridge } from './devBridge';
import { clearActiveRuntime, setActiveRuntime } from './registry';

export { resolveFactories, WARM_PRESETS, type RuntimeFactories, type FactoryName } from './factories';
export { computeGlitch, GLITCH_THICKNESS } from './glitch';
export { computeCoverFit, videoToDisplay, displayToVideo, overlaySizeFor, type CoverFit } from './viewport';
export { getActiveRuntime, subscribeRuntime } from './registry';
export { DEV_BRIDGE_ENABLED } from './devBridge';
export { hudCountdown } from './countdown';
export { createLazyTracker, type LazyTracker, type TrackerLoader, type TrackerModule } from './lazyTracker';
export type { PerfMonitor } from '@/perf';

/** Browser services the loop touches; injectable for Node tests. */
export interface RuntimeEnv {
  now(): number;
  devicePixelRatio(): number;
  /** Returns CSS size of the canvas (clientWidth/Height). */
  measure(canvas: HTMLCanvasElement): Size;
  /** Observe layout changes; returns disconnect. Optional (tests / no ResizeObserver). */
  observeResize?(canvas: HTMLCanvasElement, cb: () => void): () => void;
  /** Resolves when the HUD font is usable (best effort). */
  loadFonts?(): Promise<void>;
  /** Next-animation-frame scheduling (paused re-render). Optional (tests inject a manual queue). */
  requestAnimationFrame?(cb: (t: number) => void): number;
  cancelAnimationFrame?(id: number): void;
  /** Low-priority scheduling (shader warm-up); returns a cancel function. */
  idle?(cb: () => void): () => void;
}

export interface RuntimeOptions {
  /** Override any factory (tests, harness). Everything else resolves to real modules, then stubs. */
  factories?: Partial<RuntimeFactories>;
  env?: Partial<RuntimeEnv>;
  /** Milliseconds between store session syncs (fps, recorder, transport). Default 250. */
  sessionSyncMs?: number;
  /** Milliseconds between adaptive-quality evaluations. Default 500. */
  adaptiveIntervalMs?: number;
  /** Minimum spacing of `trackerProgress` store writes. Default 100 (≤ 10 Hz). */
  progressSyncMs?: number;
  /** A store change re-renders only when no video frame arrived within this window. Default 250. */
  pausedAfterMs?: number;
}

/** Everything in `RuntimeHandle` plus runtime extras (additive; UI may use them via the ref/registry). */
export interface AlterFrameRuntime extends RuntimeHandle {
  /** Resolves when the renderer is initialised and the source is attached (fast). Rejects if renderer init throws. */
  readonly ready: Promise<void>;
  /** Resolves when the FIRST tracker init settled (success OR failure — never rejects; see `trackerError`). */
  readonly trackerReady: Promise<void>;
  /** 0..1 model download progress (latest value; the store copy is throttled to ≤ 10 Hz); 1 once ready. */
  readonly trackerProgress: number;
  /** Mirror of `session.trackerError`. */
  readonly trackerError: string | null;
  onTrackerProgress(cb: (p: number) => void): () => void;
  /** Which factories are stubs (should be [] at integration). */
  readonly modules: { stubbed: readonly FactoryName[] };
  /** Current source (replaced by `setSource`). */
  readonly source: FrameSource;
  /** Frames rendered since start (tests / harness). */
  readonly frameCount: number;
  /** Mirror of `session.windowOpen` (window-open/close events). */
  readonly windowOpen: boolean;
  /** Whether `injectTracking` is live (dev/e2e builds only). */
  readonly injectionEnabled: boolean;
  /** Set when a frame handler threw; the loop keeps running. */
  readonly lastError: Error | null;
  /** Tracking frame used for the last rendered frame (debug overlays, harness). */
  readonly lastTracking: TrackingFrame | null;
  retryTracker(): Promise<void>;
  requestRender(): void;
  getDiagnostics(): RuntimeDiagnostics;
}

type SessionPatch = Partial<Omit<SessionSlice, 'setSession'>>;

/** Store keys whose change must become visible even when the source presents no new frame (paused file). */
const RENDER_KEYS: readonly (keyof AppState)[] = [
  'mirrored', 'hudEnabled', 'hudTintAuto', 'showFps', 'debugLandmarks', 'interaction', 'quality', 'adaptiveQuality',
  'reducedMotion', 'fitMode', 'thinStripGlitch', 'look', 'capture', 'scene', 'directorRunning', 'countdown',
];

/** Synthetic frame time used by `requestRender` (ms past the last real frame). */
const RENDER_EPSILON_MS = 0.001;

/** While a self-timer runs on a paused source the numeral is re-rendered at this cadence (≤ 10 Hz). */
const COUNTDOWN_TICK_MS = 100;

/** Tracker options the loop keeps in sync with the store (forwarded only when a value changes). */
interface TrackerSyncedOptions { mirrored: boolean; segmentationStride: number; inferenceMaxHeight: number; faceStride: number }

/** Optional diagnostics surface of the core renderer (`CoreRenderer`), read defensively. */
interface RendererExtension {
  contextLost?: boolean;
  contextLossCount?: number;
  getDebug?(): { internalWidth: number; internalHeight: number; maskFormat: string } | null;
}

function defaultEnv(): RuntimeEnv {
  const g = globalThis as typeof globalThis & { devicePixelRatio?: number; ResizeObserver?: typeof ResizeObserver; document?: Document };
  return {
    now: () => performance.now(),
    devicePixelRatio: () => g.devicePixelRatio ?? 1,
    measure: (canvas) => ({ width: canvas.clientWidth || canvas.width || 1, height: canvas.clientHeight || canvas.height || 1 }),
    observeResize: (canvas, cb) => {
      if (typeof g.ResizeObserver !== 'function') return () => {};
      const ro = new g.ResizeObserver(() => cb());
      ro.observe(canvas);
      return () => ro.disconnect();
    },
    loadFonts: async () => {
      // HUD text must not render with a fallback font in the first frames (visual-test flake).
      const fonts = g.document?.fonts;
      if (!fonts) return;
      try {
        await Promise.race([fonts.load('300 16px Inter'), new Promise((r) => setTimeout(r, 1500))]);
      } catch {
        /* font not bundled yet — fine */
      }
    },
    requestAnimationFrame: (cb) =>
      typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame(cb) : (setTimeout(() => cb(performance.now()), 16) as unknown as number),
    cancelAnimationFrame: (id) => (typeof g.cancelAnimationFrame === 'function' ? g.cancelAnimationFrame(id) : clearTimeout(id)),
    idle: (cb) => {
      if (typeof g.requestIdleCallback === 'function') {
        const id = g.requestIdleCallback(() => cb(), { timeout: 2000 });
        return () => {
          if (typeof g.cancelIdleCallback === 'function') g.cancelIdleCallback(id);
        };
      }
      const id = setTimeout(cb, 0);
      return () => clearTimeout(id);
    },
  };
}

function sameQuality(a: QualitySettings, b: QualitySettings): boolean {
  return (
    a.renderScale === b.renderScale &&
    a.maxDpr === b.maxDpr &&
    a.segmentationStride === b.segmentationStride &&
    a.inferenceMaxHeight === b.inferenceMaxHeight &&
    a.faceStride === b.faceStride
  );
}

function sameTransport(a: TransportState | null, b: TransportState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // Object.is: NaN durations (metadata pending) must compare equal, not rewrite the store every sync.
  return a.paused === b.paused && Object.is(a.currentTime, b.currentTime) && Object.is(a.duration, b.duration) && a.loop === b.loop;
}

export function startRuntime(deps: RuntimeDeps, options: RuntimeOptions = {}): AlterFrameRuntime {
  const { canvas, store } = deps;
  const env: RuntimeEnv = { ...defaultEnv(), ...options.env };
  const { factories: f, stubbed } = resolveFactories(options.factories);
  const sessionSyncMs = options.sessionSyncMs ?? 250;
  const adaptiveIntervalMs = options.adaptiveIntervalMs ?? 500;
  const progressSyncMs = options.progressSyncMs ?? 100;
  const pausedAfterMs = options.pausedAfterMs ?? 250;

  // ------------------------------------------------------------------ state
  let stopped = false;
  let rendererReady = false;
  let source: FrameSource = deps.source;
  let unsubFrame: (() => void) | null = null;
  let unsubStatus: (() => void) | null = null;
  let unsubTransport: (() => void) | null = null;
  let injected: TrackingFrame | null = null;
  let lastTracking: TrackingFrame | null = null;
  let overlaySize: Size = { width: 0, height: 0 };
  let lastCss: Size = { width: 0, height: 0 };
  let lastDpr = 0;
  let lastSessionSync = -Infinity;
  let lastAdaptive = -Infinity;
  let frameCount = 0;
  let lastError: Error | null = null;
  let directorSnapshot: SceneState | null = null;
  /** Time of the last real video frame (frame-clock domain) and the wall-clock moment it was processed. */
  let lastT = -1;
  let lastFrameWall = -Infinity;
  let renderRaf: number | null = null;
  let countdownTimer: ReturnType<typeof setTimeout> | null = null;
  let canvasListening = false;
  let cancelWarm: () => void = () => {};
  let lastContextLost = false;
  let lastReducedMotion: boolean | null = null;
  let captureRequestId = 0;
  let progress = 0;
  let lastProgressSync = -Infinity;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let initInFlight: Promise<void> | null = null;
  const progressListeners = new Set<(p: number) => void>();
  const stats: RuntimeStats = { fps: 0, frameMs: 0, trackingMs: 0, renderMs: 0 };

  // ---------------------------------------------------------------- session
  /** Writes only the keys whose value differs from the store (minimal re-renders; store = source of truth). */
  function patchSession(patch: SessionPatch): void {
    const s = store.getState();
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const key of Object.keys(patch) as (keyof SessionPatch)[]) {
      const value = patch[key];
      if (!Object.is(s[key], value)) {
        out[key] = value;
        changed = true;
      }
    }
    if (changed) s.setSession(out as SessionPatch);
  }

  // ---------------------------------------------------------------- modules
  const renderer = f.createRenderer();
  const rendererExt = renderer as Renderer & RendererExtension;
  const persona = f.createPersonaLayer();
  const interaction = f.createInteraction();
  const director = f.createDirector();
  const initialSettings = store.getState();
  const hudOptions = (): { reducedMotion: boolean; debugLandmarks: boolean } => ({ reducedMotion: store.getState().reducedMotion, debugLandmarks: store.getState().debugLandmarks });
  let lastHudOptions = hudOptions();
  const hud = f.createHud(f.debugDraw ? { ...lastHudOptions, debugDraw: f.debugDraw } : lastHudOptions);
  const hudWithOptions = hud as typeof hud & { setOptions?: (o: { reducedMotion: boolean; debugLandmarks: boolean }) => void };
  const perf = f.createPerfMonitor();
  const recorder = f.createRecorder(() => renderer.canvas);
  let trackerOpts: TrackerSyncedOptions = {
    mirrored: initialSettings.mirrored,
    segmentationStride: initialSettings.quality.segmentationStride,
    inferenceMaxHeight: initialSettings.quality.inferenceMaxHeight,
    faceStride: initialSettings.quality.faceStride,
  };
  const tracker = f.createTracker({ ...trackerOpts, numHands: 2, enableFace: true, enableSegmentation: true }, onProgress);

  if (stubbed.length > 0) devWarn(`using stub modules: ${stubbed.join(', ')}`);

  // --------------------------------------------------------------- tracker
  function clearProgressTimer(): void {
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
  }

  function flushProgress(): void {
    clearProgressTimer();
    if (stopped) return;
    lastProgressSync = env.now();
    patchSession({ trackerProgress: progress });
  }

  /** Progress callback of the tracker: listeners get every value, the store at most every `progressSyncMs`. */
  function onProgress(p: number): void {
    progress = p;
    for (const cb of progressListeners) cb(p);
    if (stopped) return;
    const elapsed = env.now() - lastProgressSync;
    if (elapsed >= progressSyncMs) flushProgress();
    else if (progressTimer === null) progressTimer = setTimeout(flushProgress, progressSyncMs - elapsed);
  }

  /** Runs `tracker.init()` once at a time and mirrors the outcome into the session. Never rejects. */
  function runTrackerInit(): Promise<void> {
    if (initInFlight) return initInFlight;
    const p: Promise<void> = (async () => {
      try {
        await tracker.init();
        if (stopped) return;
        clearProgressTimer();
        if (progress !== 1) {
          progress = 1;
          for (const cb of progressListeners) cb(1);
        }
        lastProgressSync = env.now();
        patchSession({ trackerReady: true, trackerProgress: 1, trackerError: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        devWarn(`tracker init failed: ${message}`);
        if (stopped) return;
        clearProgressTimer();
        patchSession({ trackerReady: false, trackerError: message, trackerProgress: progress });
      }
    })();
    initInFlight = p;
    void p.then(() => {
      if (initInFlight === p) initInFlight = null;
    });
    return p;
  }

  function syncTrackerOptions(state: AppState): void {
    const q = state.quality;
    const patch: Partial<TrackerOptions> = {};
    if (state.mirrored !== trackerOpts.mirrored) patch.mirrored = state.mirrored;
    if (q.segmentationStride !== trackerOpts.segmentationStride) patch.segmentationStride = q.segmentationStride;
    if (q.inferenceMaxHeight !== trackerOpts.inferenceMaxHeight) patch.inferenceMaxHeight = q.inferenceMaxHeight;
    if (q.faceStride !== trackerOpts.faceStride) patch.faceStride = q.faceStride;
    if (Object.keys(patch).length === 0) return;
    trackerOpts = { mirrored: state.mirrored, segmentationStride: q.segmentationStride, inferenceMaxHeight: q.inferenceMaxHeight, faceStride: q.faceStride };
    tracker.setOptions(patch);
  }

  // -------------------------------------------------------------- resizing
  /** Canvas (display) size → renderer; intrinsic video size → overlays. */
  function syncSizes(force = false): void {
    if (!rendererReady) return;
    const css = env.measure(canvas);
    const state = store.getState();
    const dpr = Math.min(env.devicePixelRatio(), state.quality.maxDpr);
    if (force || css.width !== lastCss.width || css.height !== lastCss.height || dpr !== lastDpr) {
      lastCss = css;
      lastDpr = dpr;
      renderer.resize(css.width, css.height, dpr);
    }
    const vs = overlaySizeFor(source.video.videoWidth || source.width, source.video.videoHeight || source.height);
    if (force || vs.width !== overlaySize.width || vs.height !== overlaySize.height) {
      overlaySize = vs;
      persona.resize(vs);
      hud.resize(vs);
    }
  }
  const disconnectResize = env.observeResize ? env.observeResize(canvas, () => syncSizes()) : () => {};

  // ---------------------------------------------------------- context loss
  /** Mirrors the renderer's context-lost flag into the session; invalidates the persona canvases once the context is back. */
  function syncContextLost(): void {
    const lost = rendererExt.contextLost === true;
    if (lost === lastContextLost) return;
    lastContextLost = lost;
    patchSession({ contextLost: lost });
    if (!lost) persona.invalidate?.();
  }
  const onContextLostEvent = (): void => {
    if (!stopped) syncContextLost();
  };
  const onContextRestoredEvent = (): void => {
    if (stopped) return;
    syncContextLost();
    scheduleRender(); // a paused source presents no frame on its own
  };
  function installCanvasListeners(): void {
    if (typeof canvas.addEventListener !== 'function') return;
    canvas.addEventListener('webglcontextlost', onContextLostEvent);
    canvas.addEventListener('webglcontextrestored', onContextRestoredEvent);
    canvasListening = true;
  }
  function removeCanvasListeners(): void {
    if (!canvasListening) return;
    canvas.removeEventListener('webglcontextlost', onContextLostEvent);
    canvas.removeEventListener('webglcontextrestored', onContextRestoredEvent);
    canvasListening = false;
  }

  // -------------------------------------------------------------- warm-up
  function scheduleWarm(): () => void {
    if (typeof renderer.warm !== 'function' || !env.idle) return () => {};
    const presets: readonly StylePreset[] = f.warmPresets;
    return env.idle(() => {
      if (stopped) return;
      try {
        renderer.warm?.(presets);
      } catch (err) {
        devWarn(`shader warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  // ----------------------------------------------------------------- source
  function syncSourceSession(): void {
    const s = source as FrameSource & { error?: string | null };
    patchSession({ sourceKind: source.kind, sourceStatus: source.status, sourceError: s.error ?? null });
  }

  function transportSnapshot(): TransportState | null {
    const tr = source.transport;
    return tr ? { paused: tr.paused, currentTime: tr.currentTime, duration: tr.duration, loop: tr.loop } : null;
  }

  function syncTransport(): void {
    const next = transportSnapshot();
    const state = store.getState();
    if (!sameTransport(state.transport, next)) state.setSession({ transport: next });
  }

  function attachSource(next: FrameSource): void {
    source = next;
    if (isObservableSource(next)) {
      unsubStatus = next.onStatus(() => {
        syncSourceSession();
        if (next.status === 'ready') syncSizes(true);
      });
    }
    if (hasTransportEvents(next)) {
      unsubTransport = next.onTransport(() => {
        if (stopped || source !== next) return;
        syncTransport(); // same task as the command: the UI mirror never waits for the element's event task
        // A paused clip must show its new state right away — except mid-seek: the command-time
        // notification arrives while the element still holds the OLD frame (`seeking` true); the
        // `seeked` event re-notifies once the new frame is decoded, and that one renders.
        if (next.video.seeking !== true) requestRender();
      });
    }
    unsubFrame = next.onFrame(onVideoFrame);
    syncSourceSession();
    syncTransport();
  }

  function detachSource(stopIt: boolean): void {
    unsubFrame?.();
    unsubFrame = null;
    unsubStatus?.();
    unsubStatus = null;
    unsubTransport?.();
    unsubTransport = null;
    if (stopIt) source.stop();
  }

  async function ensureStarted(s: FrameSource): Promise<void> {
    if (s.status === 'idle') {
      try {
        await s.start();
      } catch {
        // status/error already carried by the source; UI shows ErrorPanel.
      }
    }
    syncSourceSession();
    if (!isObservableSource(s)) syncSizes(true);
  }

  // ------------------------------------------------------------------ frame
  /** Hold-still gesture → one capture request the app performs and clears. */
  function requestDwellCapture(): void {
    const state = store.getState();
    const action = state.capture.dwellAction;
    if (action === 'off' || state.captureRequest) return;
    if (action === 'record' && (recorder.state !== 'idle' || state.countdown)) return;
    captureRequestId += 1;
    state.setSession({ captureRequest: { action, id: captureRequestId, source: 'dwell' } });
  }

  function applyEvents(events: InteractionEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'window-open':
          patchSession({ windowOpen: true });
          break;
        case 'window-close':
          patchSession({ windowOpen: false });
          break;
        case 'cycle-persona': {
          // Director owns the scene while running (precedence: Director > gesture/UI).
          const state = store.getState();
          if (!state.directorRunning && state.interaction.gestureCycleEnabled) state.cyclePersona();
          break;
        }
        case 'hands-together-armed':
          break;
        case 'dwell':
          requestDwellCapture();
          break;
      }
    }
  }

  function runDirector(t: number): void {
    const state = store.getState();
    if (state.directorRunning && !director.running) {
      directorSnapshot = { ...state.scene };
      director.start(t);
    } else if (!state.directorRunning && director.running) {
      director.stop();
      if (directorSnapshot) state.setScene({ base: directorSnapshot.base, persona: directorSnapshot.persona });
      directorSnapshot = null;
    }
    if (director.running) {
      const scene = director.update(t);
      // Only base/persona flow through; the store derives hudTint (hudTintAuto) — single source of truth.
      if (scene && (scene.base !== state.scene.base || scene.persona !== state.scene.persona)) state.setScene({ base: scene.base, persona: scene.persona });
    }
  }

  function onVideoFrame(t: number): void {
    if (stopped || !rendererReady) return;
    lastT = t;
    lastFrameWall = env.now();
    runStep(t);
  }

  function runStep(t: number): void {
    const frameStart = env.now();
    try {
      step(t, frameStart);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      devWarn(`frame error: ${lastError.message}`);
    }
  }

  /** Renders one frame now, re-using the last frame time (+ε) because the source presented nothing new. */
  function requestRender(): void {
    if (stopped || !rendererReady) return;
    runStep((lastT < 0 ? 0 : lastT) + RENDER_EPSILON_MS);
  }

  /** One deferred render per burst of store changes while the source is paused (debounced to a single animation frame). */
  function scheduleRender(): void {
    if (stopped || renderRaf !== null || !env.requestAnimationFrame) return;
    if (env.now() - lastFrameWall < pausedAfterMs) return; // frames are flowing: the next one shows the change
    renderRaf = env.requestAnimationFrame(() => {
      renderRaf = null;
      if (stopped) return;
      if (env.now() - lastFrameWall < pausedAfterMs) return; // a frame arrived meanwhile
      requestRender();
    });
  }

  const unsubStore = store.subscribe((state, prev) => {
    if (stopped || !rendererReady) return;
    if (!RENDER_KEYS.some((k) => state[k] !== prev[k])) return;
    scheduleRender();
  });

  function clearCountdownTick(): void {
    if (countdownTimer !== null) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
  }

  /**
   * A paused source presents no frames, so a running self-timer would freeze on its first numeral:
   * re-render on a timer until the countdown ends. While frames flow the next frame does the job.
   */
  function armCountdownTick(countdownLive: boolean): void {
    clearCountdownTick();
    if (stopped || !countdownLive) return;
    if (env.now() - lastFrameWall < pausedAfterMs) return;
    countdownTimer = setTimeout(() => {
      countdownTimer = null;
      if (!stopped) scheduleRender();
    }, COUNTDOWN_TICK_MS);
  }

  function step(t: number, frameStart: number): void {
    const state = store.getState();
    const video = source.video;
    const videoWidth = video.videoWidth || source.width;
    const videoHeight = video.videoHeight || source.height;
    if (!(videoWidth > 0 && videoHeight > 0)) return; // metadata not yet available

    syncTrackerOptions(state);
    syncSizes();
    syncContextLost();

    // 1. Tracking (or injected frame in dev/e2e).
    const t0 = env.now();
    let tracking: TrackingFrame | null = null;
    if (injected) tracking = injected;
    else if (tracker.ready) tracking = tracker.update(video, t);
    lastTracking = tracking;
    const trackingMs = env.now() - t0;

    // 2. Interaction → events → store.
    const out = interaction.update(tracking, t, state.scene, state.interaction);
    applyEvents(out.events);

    // 3. Director (may change the scene through the store).
    runDirector(t);
    const scene = store.getState().scene;

    // 4. Persona + HUD overlays (intrinsic video space).
    if (persona.setReducedMotion && state.reducedMotion !== lastReducedMotion) {
      lastReducedMotion = state.reducedMotion;
      persona.setReducedMotion(state.reducedMotion);
    }
    persona.update(tracking, scene, t, state.look);
    let hudOverlay: typeof hud.canvas | null = null;
    const countdown = hudCountdown(state.countdown, frameStart);
    // A running self-timer is drawn even with the HUD callouts switched off (numeral only).
    if (state.hudEnabled || countdown) {
      // The HUD's `setOptions` resets its redraw-dedupe key → only call when something changed.
      if (hudWithOptions.setOptions && (state.reducedMotion !== lastHudOptions.reducedMotion || state.debugLandmarks !== lastHudOptions.debugLandmarks)) {
        lastHudOptions = { reducedMotion: state.reducedMotion, debugLandmarks: state.debugLandmarks };
        hudWithOptions.setOptions(lastHudOptions);
      }
      const model = state.hudEnabled
        ? hud.buildModel(tracking, out.quad, scene, t, {
            recording: recorder.state === 'recording',
            fps: state.showFps ? Math.round(perf.fps()) : null,
            showFps: state.showFps,
            countdown,
            dwellProgress: out.debug.dwellProgress ?? null,
          })
        : // HUD off: null frame + null quad → no callouts, no dwell ring (it anchors on the corner callout), no badges.
          hud.buildModel(null, null, scene, t, { recording: false, fps: null, showFps: false, countdown, dwellProgress: null });
      hud.draw(model);
      hudOverlay = hud.canvas;
    }

    // 5. Compose.
    // Mapping: window portrait → paper-portrait, masked/suit → comic(+backdrop);
    // base comic → COMIC_BASE_PRESET (no backdrop pass: the real room stays visible as comic).
    const windowStyle = f.presetForLayer(scene, 'window') ?? f.stylePresets.comic;
    const baseStyle = f.presetForLayer(scene, 'base');
    const r0 = env.now();
    renderer.render({
      video,
      videoWidth,
      videoHeight,
      mirrored: state.mirrored,
      tracking,
      quad: out.quad,
      scene,
      baseStyle,
      windowStyle,
      personaOverlay: persona.overlay,
      personaBackdrop: windowStyle.usesBackdrop ? persona.backdrop : null,
      hudOverlay,
      glitch: computeGlitch(out.quad, state),
      quality: state.quality,
      fitMode: state.fitMode,
      look: state.look,
      time: t / 1000,
    });
    const renderMs = env.now() - r0;
    const frameMs = env.now() - frameStart;
    frameCount += 1;

    // 6. Perf + adaptive quality + session sync.
    perf.sample({ frameMs, trackingMs, renderMs });
    stats.fps = perf.fps();
    stats.frameMs = frameMs;
    stats.trackingMs = trackingMs;
    stats.renderMs = renderMs;

    if (state.adaptiveQuality && t - lastAdaptive >= adaptiveIntervalMs) {
      lastAdaptive = t;
      const next = f.adaptivePolicy.evaluate(perf.recent(5000), state.quality);
      if (next && !sameQuality(next, state.quality)) state.setSettings({ quality: next });
    }
    if (t - lastSessionSync >= sessionSyncMs) {
      lastSessionSync = t;
      patchSession({
        fps: Math.round(stats.fps),
        recorderState: recorder.state,
        recorderElapsedMs: recorder.state === 'idle' ? 0 : Math.floor(recorder.elapsedMs),
        trackerReady: tracker.ready,
      });
      syncTransport();
    }
    armCountdownTick(countdown !== null);
  }

  // ------------------------------------------------------------------- init
  const ready: Promise<void> = (async () => {
    await renderer.init(canvas);
    if (stopped) return;
    rendererReady = true;
    installCanvasListeners();
    syncContextLost();
    syncSizes(true);
    cancelWarm = scheduleWarm();
    await env.loadFonts?.();
    if (stopped) return;
    attachSource(source);
    void ensureStarted(source);
  })();
  ready.catch((err: unknown) => {
    lastError = err instanceof Error ? err : new Error(String(err));
  });
  // Tracker init runs in parallel with the source prompt; frames render untracked until it is ready.
  const trackerReady: Promise<void> = runTrackerInit();

  // ----------------------------------------------------------------- handle
  const handle: AlterFrameRuntime = {
    ready,
    trackerReady,
    recorder,
    get trackerProgress() {
      return progress;
    },
    get trackerError() {
      return store.getState().trackerError;
    },
    onTrackerProgress(cb) {
      progressListeners.add(cb);
      cb(progress);
      return () => {
        progressListeners.delete(cb);
      };
    },
    modules: { stubbed },
    get source() {
      return source;
    },
    get frameCount() {
      return frameCount;
    },
    get windowOpen() {
      return store.getState().windowOpen;
    },
    get injectionEnabled() {
      return DEV_BRIDGE_ENABLED;
    },
    get lastError() {
      return lastError;
    },
    get lastTracking() {
      return lastTracking;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      // Synchronous teardown so React StrictMode's mount→unmount→mount leaves nothing behind.
      detachSource(true);
      disconnectResize();
      unsubStore();
      if (renderRaf !== null) {
        env.cancelAnimationFrame?.(renderRaf);
        renderRaf = null;
      }
      clearCountdownTick();
      cancelWarm();
      clearProgressTimer();
      removeCanvasListeners();
      removeBridge();
      if (director.running) director.stop();
      interaction.reset();
      progressListeners.clear();
      if (recorder.state === 'recording') void recorder.stop().catch(() => undefined);
      tracker.dispose();
      if (rendererReady) renderer.dispose();
      // Runtime-owned session fields go back to their idle values.
      patchSession({ windowOpen: false, transport: null, contextLost: false });
      clearActiveRuntime(handle);
    },
    snapshot(aspect: CaptureAspect, opts?: SnapshotOptions) {
      return recorder.snapshot(aspect, opts);
    },
    getStats() {
      return { ...stats };
    },
    async retryTracker() {
      if (stopped) return;
      if (initInFlight) return initInFlight;
      progress = 0;
      for (const cb of progressListeners) cb(0);
      clearProgressTimer();
      lastProgressSync = -Infinity; // the first new progress value shows immediately
      patchSession({ trackerError: null, trackerProgress: 0 });
      await runTrackerInit();
    },
    requestRender,
    getDiagnostics(): RuntimeDiagnostics {
      const state = store.getState();
      const info = tracker.getInfo?.();
      const hasRendererExt = typeof rendererExt.contextLost === 'boolean' || typeof rendererExt.getDebug === 'function';
      const dbg = typeof rendererExt.getDebug === 'function' ? rendererExt.getDebug() : null;
      return {
        fps: stats.fps,
        frameMs: stats.frameMs,
        trackingMs: stats.trackingMs,
        renderMs: stats.renderMs,
        gpuMs: renderer.stats.gpuMs ?? null,
        frames: frameCount,
        tracker: {
          ready: tracker.ready,
          progress,
          error: state.trackerError,
          delegates: info ? { ...info.delegates } : null,
          inferenceSize: info?.inferenceSize ? { ...info.inferenceSize } : null,
          warnings: info ? [...info.warnings] : [],
        },
        renderer: hasRendererExt
          ? {
              contextLost: rendererExt.contextLost === true,
              contextLossCount: rendererExt.contextLossCount ?? 0,
              internal: dbg ? { width: dbg.internalWidth, height: dbg.internalHeight } : null,
              maskFormat: dbg?.maskFormat ?? null,
            }
          : null,
        quality: { ...state.quality },
        source: { kind: source.kind, status: source.status, width: source.width, height: source.height },
        modules: { stubbed: [...stubbed] },
      };
    },
    async setSource(next: FrameSource) {
      if (stopped) throw new Error('Runtime stopped');
      if (next === source) return;
      detachSource(true);
      attachSource(next);
      lastTracking = null;
      interaction.reset();
      await ensureStarted(next);
    },
  };
  // Dev/e2e only: present in the object only when the gate is open so production has no hook at all.
  if (DEV_BRIDGE_ENABLED) {
    handle.injectTracking = (frame: TrackingFrame | null) => {
      injected = frame;
    };
  }
  const removeBridge = installDevBridge(handle);
  setActiveRuntime(handle);
  return handle;
}
