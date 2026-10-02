/**
 * W2 — runtime loop. `startRuntime(deps)` wires FrameSource → Tracker →
 * Interaction → Director → PersonaLayer → HUD → Renderer → Perf, once per
 * presented video frame, and returns a `RuntimeHandle`.
 *
 * Coordinate contract (see ./viewport.ts): tracker output and overlay
 * canvases live in the INTRINSIC video frame; the renderer performs the single
 * cover-fit into the canvas. The runtime passes `videoWidth/videoHeight`
 * consistently to tracker, persona, HUD and renderer and never remaps.
 */
import type {
  CaptureAspect,
  FrameSource,
  QualitySettings,
  RuntimeDeps,
  RuntimeHandle,
  RuntimeStats,
  SceneState,
  Size,
  TrackingFrame,
} from '@/types';
import { isObservableSource } from '@/media/sourceBase';
import { resolveFactories, type FactoryName, type RuntimeFactories } from './factories';
import { computeGlitch } from './glitch';
import { overlaySizeFor } from './viewport';
import { DEV_BRIDGE_ENABLED, devWarn, installDevBridge } from './devBridge';
import { clearActiveRuntime, setActiveRuntime } from './registry';

export { resolveFactories, type RuntimeFactories, type FactoryName } from './factories';
export { computeGlitch, GLITCH_THICKNESS } from './glitch';
export { computeCoverFit, videoToDisplay, displayToVideo, overlaySizeFor, type CoverFit } from './viewport';
export { getActiveRuntime, subscribeRuntime } from './registry';
export { DEV_BRIDGE_ENABLED } from './devBridge';
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
}

export interface RuntimeOptions {
  /** Override any factory (tests, harness). Everything else resolves to real modules, then stubs. */
  factories?: Partial<RuntimeFactories>;
  env?: Partial<RuntimeEnv>;
  /** Milliseconds between store session syncs (fps, recorder). Default 250. */
  sessionSyncMs?: number;
  /** Milliseconds between adaptive-quality evaluations. Default 500. */
  adaptiveIntervalMs?: number;
}

/** Everything in `RuntimeHandle` plus W2 extras (additive; UI may use them via the ref/registry). */
export interface AlterFrameRuntime extends RuntimeHandle {
  /** Resolves when the renderer is initialised and the source is attached (fast). Rejects if renderer init throws. */
  readonly ready: Promise<void>;
  /** Resolves when tracker init settled (success OR failure — never rejects; see `trackerError`). Model download can take seconds. */
  readonly trackerReady: Promise<void>;
  /** 0..1 model download progress (W3 `onProgress`); 1 once ready. */
  readonly trackerProgress: number;
  readonly trackerError: string | null;
  onTrackerProgress(cb: (p: number) => void): () => void;
  /** Which factories are stubs (should be [] at integration). */
  readonly modules: { stubbed: readonly FactoryName[] };
  /** Current source (replaced by `setSource`). */
  readonly source: FrameSource;
  /** Frames rendered since start (tests / harness). */
  readonly frameCount: number;
  /** True while the window quad is visible (window-open/close events). */
  readonly windowOpen: boolean;
  /** Whether `injectTracking` is live (dev/e2e builds only). */
  readonly injectionEnabled: boolean;
  /** Set when a frame handler threw; the loop keeps running. */
  readonly lastError: Error | null;
  /** Tracking frame used for the last rendered frame (debug overlays, harness). */
  readonly lastTracking: TrackingFrame | null;
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
  };
}

function sameQuality(a: QualitySettings, b: QualitySettings): boolean {
  return a.renderScale === b.renderScale && a.maxDpr === b.maxDpr && a.segmentationStride === b.segmentationStride;
}

export function startRuntime(deps: RuntimeDeps, options: RuntimeOptions = {}): AlterFrameRuntime {
  const { canvas, store } = deps;
  const env: RuntimeEnv = { ...defaultEnv(), ...options.env };
  const { factories: f, stubbed } = resolveFactories(options.factories);
  const sessionSyncMs = options.sessionSyncMs ?? 250;
  const adaptiveIntervalMs = options.adaptiveIntervalMs ?? 500;

  // ---------------------------------------------------------------- modules
  const renderer = f.createRenderer();
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

  let trackerProgress = 0;
  let trackerError: string | null = null;
  const progressListeners = new Set<(p: number) => void>();
  const tracker = f.createTracker(
    { mirrored: initialSettings.mirrored, segmentationStride: initialSettings.quality.segmentationStride, numHands: 2, enableFace: true, enableSegmentation: true },
    (p) => {
      trackerProgress = p;
      for (const cb of progressListeners) cb(p);
    },
  );

  // ------------------------------------------------------------------ state
  let stopped = false;
  let rendererReady = false;
  let source: FrameSource = deps.source;
  let unsubFrame: (() => void) | null = null;
  let unsubStatus: (() => void) | null = null;
  let injected: TrackingFrame | null = null;
  let lastTracking: TrackingFrame | null = null;
  let lastMirrored = initialSettings.mirrored;
  let lastStride = initialSettings.quality.segmentationStride;
  let overlaySize: Size = { width: 0, height: 0 };
  let lastCss: Size = { width: 0, height: 0 };
  let lastDpr = 0;
  let lastSessionSync = -Infinity;
  let lastAdaptive = -Infinity;
  let lastFps = -1;
  let frameCount = 0;
  let windowOpen = false;
  let lastError: Error | null = null;
  let directorSnapshot: SceneState | null = null;
  const stats: RuntimeStats = { fps: 0, frameMs: 0, trackingMs: 0, renderMs: 0 };

  if (stubbed.length > 0) devWarn(`using stub modules: ${stubbed.join(', ')}`);

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

  // ----------------------------------------------------------------- source
  function syncSourceSession(): void {
    const s = source as FrameSource & { error?: string | null };
    store.getState().setSession({ sourceKind: source.kind, sourceStatus: source.status, sourceError: s.error ?? null });
  }

  function attachSource(next: FrameSource): void {
    source = next;
    if (isObservableSource(next)) {
      unsubStatus = next.onStatus(() => {
        syncSourceSession();
        if (next.status === 'ready') syncSizes(true);
      });
    }
    unsubFrame = next.onFrame(onVideoFrame);
    syncSourceSession();
  }

  function detachSource(stopIt: boolean): void {
    unsubFrame?.();
    unsubFrame = null;
    unsubStatus?.();
    unsubStatus = null;
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
  function applyEvents(events: ReturnType<typeof interaction.update>['events']): void {
    const state = store.getState();
    for (const ev of events) {
      switch (ev.type) {
        case 'window-open':
          windowOpen = true;
          break;
        case 'window-close':
          windowOpen = false;
          break;
        case 'cycle-persona':
          // Director owns the scene while running (precedence: Director > gesture/UI).
          if (!state.directorRunning && state.interaction.gestureCycleEnabled) state.cyclePersona();
          break;
        case 'hands-together-armed':
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
    const frameStart = env.now();
    try {
      step(t, frameStart);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      devWarn(`frame error: ${lastError.message}`);
    }
  }

  function step(t: number, frameStart: number): void {
    const state = store.getState();
    const video = source.video;
    const videoWidth = video.videoWidth || source.width;
    const videoHeight = video.videoHeight || source.height;
    if (!(videoWidth > 0 && videoHeight > 0)) return; // metadata not yet available

    // Settings that live in the tracker.
    if (state.mirrored !== lastMirrored || state.quality.segmentationStride !== lastStride) {
      lastMirrored = state.mirrored;
      lastStride = state.quality.segmentationStride;
      tracker.setOptions({ mirrored: lastMirrored, segmentationStride: lastStride });
    }
    syncSizes();

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
    persona.update(tracking, scene, t);
    let hudOverlay: typeof hud.canvas | null = null;
    if (state.hudEnabled) {
      // W8 `setOptions` resets its redraw-dedupe key → only call when something changed.
      if (hudWithOptions.setOptions && (state.reducedMotion !== lastHudOptions.reducedMotion || state.debugLandmarks !== lastHudOptions.debugLandmarks)) {
        lastHudOptions = { reducedMotion: state.reducedMotion, debugLandmarks: state.debugLandmarks };
        hudWithOptions.setOptions(lastHudOptions);
      }
      const fps = state.showFps ? Math.round(perf.fps()) : null;
      const model = hud.buildModel(tracking, out.quad, scene, t, { recording: recorder.state === 'recording', fps, showFps: state.showFps });
      hud.draw(model);
      hudOverlay = hud.canvas;
    }

    // 5. Compose.
    // W5 mapping: window portrait → paper-portrait, masked/suit → comic(+backdrop);
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
      const fpsRounded = Math.round(stats.fps);
      const patch: Parameters<typeof state.setSession>[0] = {};
      if (fpsRounded !== lastFps) {
        lastFps = fpsRounded;
        patch.fps = fpsRounded;
      }
      const session = store.getState();
      if (session.recorderState !== recorder.state) patch.recorderState = recorder.state;
      const elapsed = recorder.state === 'idle' ? 0 : Math.floor(recorder.elapsedMs);
      if (session.recorderElapsedMs !== elapsed) patch.recorderElapsedMs = elapsed;
      if (session.trackerReady !== tracker.ready) patch.trackerReady = tracker.ready;
      if (Object.keys(patch).length > 0) state.setSession(patch);
    }
  }

  // ------------------------------------------------------------------- init
  const ready: Promise<void> = (async () => {
    await renderer.init(canvas);
    if (stopped) return;
    rendererReady = true;
    syncSizes(true);
    await env.loadFonts?.();
    if (stopped) return;
    attachSource(source);
    void ensureStarted(source);
  })();
  ready.catch((err: unknown) => {
    lastError = err instanceof Error ? err : new Error(String(err));
  });
  // Tracker init runs in parallel with the source prompt; frames render untracked until it is ready.
  const trackerReady: Promise<void> = (async () => {
    try {
      await tracker.init();
      if (stopped) return;
      trackerProgress = 1;
      store.getState().setSession({ trackerReady: true });
    } catch (err) {
      trackerError = err instanceof Error ? err.message : String(err);
      devWarn(`tracker init failed: ${trackerError}`);
      if (!stopped) store.getState().setSession({ trackerReady: false });
    }
  })();

  // ----------------------------------------------------------------- handle
  const handle: AlterFrameRuntime = {
    ready,
    trackerReady,
    recorder,
    get trackerProgress() {
      return trackerProgress;
    },
    get trackerError() {
      return trackerError;
    },
    onTrackerProgress(cb) {
      progressListeners.add(cb);
      cb(trackerProgress);
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
      return windowOpen;
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
      removeBridge();
      if (director.running) director.stop();
      interaction.reset();
      progressListeners.clear();
      if (recorder.state === 'recording') void recorder.stop().catch(() => undefined);
      tracker.dispose();
      if (rendererReady) renderer.dispose();
      clearActiveRuntime(handle);
    },
    snapshot(aspect: CaptureAspect) {
      return recorder.snapshot(aspect);
    },
    getStats() {
      return { ...stats };
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
