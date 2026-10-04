/**
 * Shared fakes for the runtime-loop tests: an in-memory AppStore, a fake
 * FrameSource (optionally with a file transport), a deterministic RuntimeEnv
 * (manual rAF / idle queues, controllable clock) and factory wrappers that
 * record call order and every value the loop forwards.
 */
import { create } from 'zustand';
import type {
  AppState,
  AppStore,
  FileTransport,
  FrameSource,
  HudExtras,
  LookSettings,
  SourceStatus,
  StylePreset,
  TrackerInfo,
  TrackingFrame,
  TransportState,
  HandTrack,
  Vec2,
} from '@/types';
import { DEFAULT_CAPTURE_SETTINGS, DEFAULT_INTERACTION_SETTINGS, DEFAULT_LOOK, DEFAULT_QUALITY, DEFAULT_SCENE, PERSONA_ORDER } from '@/types';
import type { RuntimeFactories, HudFactoryOptions } from '@/runtime/factories';
import type { RuntimeEnv } from '@/runtime';
import {
  createStubDirector,
  createStubHud,
  createStubInteraction,
  createStubPerfMonitor,
  createStubPersonaLayer,
  createStubRecorder,
  createStubRenderer,
  createStubTracker,
  stubAdaptivePolicy,
  stubPresetForLayer,
  STUB_STYLE_PRESETS,
} from '@/runtime/stubs';

export function makeStore(): AppStore {
  return create<AppState>()((set, get) => ({
    mirrored: true,
    hudEnabled: true,
    hudTintAuto: true,
    showFps: true,
    debugLandmarks: false,
    interaction: { ...DEFAULT_INTERACTION_SETTINGS },
    quality: { ...DEFAULT_QUALITY },
    adaptiveQuality: true,
    reducedMotion: false,
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
      get().setScene({ persona: PERSONA_ORDER[(i + 1) % PERSONA_ORDER.length]! });
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
}

/** In-memory FileTransport: every control fires the subscribed listeners like the real source does. */
export class FakeTransport implements FileTransport {
  paused = true;
  currentTime = 0;
  duration = 10;
  loop = true;
  private listeners = new Set<(s: TransportState) => void>();
  play(): Promise<boolean> {
    this.paused = false;
    this.fire();
    return Promise.resolve(true);
  }
  pause(): void {
    this.paused = true;
    this.fire();
  }
  seek(seconds: number): void {
    this.currentTime = Math.min(this.duration, Math.max(0, seconds));
    this.fire();
  }
  setLoop(loop: boolean): void {
    this.loop = loop;
    this.fire();
  }
  state(): TransportState {
    return { paused: this.paused, currentTime: this.currentTime, duration: this.duration, loop: this.loop };
  }
  subscribe(cb: (s: TransportState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  fire(): void {
    const s = this.state();
    for (const cb of [...this.listeners]) cb(s);
  }
}

export class FakeSource implements FrameSource {
  kind: 'camera' | 'file' = 'camera';
  status: SourceStatus = 'idle';
  error: string | null = null;
  facingMode: 'user' | 'environment' = 'user';
  video = { videoWidth: 1280, videoHeight: 720, currentTime: 0 } as unknown as HTMLVideoElement;
  width = 1280;
  height = 720;
  startCalls = 0;
  stopCalls = 0;
  transport?: FileTransport;
  onTransport?: (cb: (s: TransportState) => void) => () => void;
  private frameListeners = new Set<(t: number, meta: { presentedFrames: number }) => void>();
  private statusListeners = new Set<(s: SourceStatus, e: string | null) => void>();
  constructor(public autoReady = true) {}
  /** Turns this fake into a file source with a transport (call before boot). */
  withTransport(): FakeTransport {
    const tr = new FakeTransport();
    this.kind = 'file';
    this.transport = tr;
    this.onTransport = (cb) => tr.subscribe(cb);
    return tr;
  }
  start(): Promise<void> {
    this.startCalls += 1;
    if (this.autoReady) this.setStatus('ready');
    return Promise.resolve();
  }
  stop(): void {
    this.stopCalls += 1;
    this.setStatus('idle');
  }
  onFrame(cb: (t: number, meta: { presentedFrames: number }) => void): () => void {
    this.frameListeners.add(cb);
    return () => {
      this.frameListeners.delete(cb);
    };
  }
  onStatus(cb: (s: SourceStatus, e: string | null) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }
  setStatus(s: SourceStatus, e: string | null = null): void {
    this.status = s;
    this.error = e;
    for (const cb of this.statusListeners) cb(s, e);
  }
  emitFrame(t: number): void {
    for (const cb of [...this.frameListeners]) cb(t, { presentedFrames: 1 });
  }
  get frameListenerCount(): number {
    return this.frameListeners.size;
  }
}

/** Canvas stand-in: size + the event surface the runtime uses for context-loss notifications. */
export interface FakeCanvas extends HTMLCanvasElement {
  dispatch(type: string): void;
  listenerCount(type: string): number;
}

export function fakeCanvas(cssW = 800, cssH = 450): FakeCanvas {
  const listeners = new Map<string, Set<() => void>>();
  const c = {
    width: 300,
    height: 150,
    clientWidth: cssW,
    clientHeight: cssH,
    addEventListener(type: string, cb: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      listeners.get(type)?.delete(cb);
    },
    dispatch(type: string) {
      for (const cb of [...(listeners.get(type) ?? [])]) cb();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return c as unknown as FakeCanvas;
}

/** Deterministic RuntimeEnv: controllable clock, manual animation-frame and idle queues. */
export function fakeEnv(dpr = 2) {
  let now = 0;
  const rafQueue = new Map<number, (t: number) => void>();
  const idleQueue = new Map<number, () => void>();
  let rafId = 0;
  let idleId = 0;
  const env: Partial<RuntimeEnv> = {
    now: () => now,
    devicePixelRatio: () => dpr,
    requestAnimationFrame: (cb) => {
      const id = ++rafId;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id) => {
      rafQueue.delete(id);
    },
    idle: (cb) => {
      const id = ++idleId;
      idleQueue.set(id, cb);
      return () => {
        idleQueue.delete(id);
      };
    },
  };
  return {
    env,
    setNow: (t: number) => (now = t),
    /** Runs every queued animation-frame callback once. */
    flushRaf(t = now): void {
      const cbs = [...rafQueue.values()];
      rafQueue.clear();
      for (const cb of cbs) cb(t);
    },
    flushIdle(): void {
      const cbs = [...idleQueue.values()];
      idleQueue.clear();
      for (const cb of cbs) cb();
    },
    get rafPending(): number {
      return rafQueue.size;
    },
    get idlePending(): number {
      return idleQueue.size;
    },
  };
}

export function hand(side: 'left' | 'right', indexTip: Vec2, thumbTip: Vec2): HandTrack {
  const palm = { x: (indexTip.x + thumbTip.x) / 2, y: (indexTip.y + thumbTip.y) / 2 + 0.1 };
  return { side, landmarks: [], score: 0.95, indexTip, thumbTip, palmCenter: palm, size: 0.2 };
}

export function frameWithHands(t: number): TrackingFrame {
  return {
    t,
    sourceWidth: 1280,
    sourceHeight: 720,
    hands: [hand('left', { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.6 }), hand('right', { x: 0.7, y: 0.3 }, { x: 0.7, y: 0.6 })],
    face: null,
    segmentation: null,
    timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 },
  };
}

export function fakeTrackerInfo(): TrackerInfo {
  return {
    delegates: { hands: 'GPU', face: 'GPU', segmentation: 'CPU' },
    warnings: ['[tracking] test warning'],
    pending: Promise.resolve(),
    segmentationLabels: ['selfie'],
    segmentationChannel: 0,
    lastMaskFromGpu: false,
    lastMaskFlippedY: false,
    lastMaskSize: { width: 256, height: 256 },
    inferenceSize: { width: 1280, height: 720 },
  };
}

export interface Recorded {
  calls: string[];
  factories: RuntimeFactories;
  disposed: { tracker: number; renderer: number };
  resizes: { renderer: Array<[number, number, number]>; persona: Array<{ width: number; height: number }>; hud: Array<{ width: number; height: number }> };
  renderInputs: Parameters<RuntimeFactories['createRenderer'] extends () => infer R ? (R extends { render: infer F } ? F : never) : never>[0][];
  setOptions: Array<Record<string, unknown>>;
  /** Options the runtime passed to `createTracker`. */
  trackerOpts: Array<Record<string, unknown>>;
  trackerInfo: TrackerInfo;
  hudOpts: Array<HudFactoryOptions | null>;
  hudSetOptions: Array<{ reducedMotion: boolean; debugLandmarks: boolean }>;
  hudExtras: HudExtras[];
  /** Whether each hud.buildModel call received a frame / quad (null = countdown-only model). */
  hudBuildArgs: Array<{ frame: 'frame' | null; quad: 'quad' | null }>;
  /** `look` argument of every persona.update call. */
  personaLooks: Array<LookSettings | undefined>;
  personaReducedMotion: boolean[];
  personaInvalidates: number;
  warmed: Array<readonly StylePreset[]>;
  /** Mutable renderer extension state (CoreRenderer shape) the tests flip. */
  rendererExt: { contextLost: boolean; contextLossCount: number; debug: { internalWidth: number; internalHeight: number; maskFormat: 'R8' | 'R32F' } | null };
  rendererStats: { lastFrameMs: number; passes: number; gpuMs: number | null };
}

/** Wraps the stub factories so every module call is logged in order. */
export function recordingFactories(overrides: Partial<RuntimeFactories> = {}): Recorded {
  const calls: string[] = [];
  const disposed = { tracker: 0, renderer: 0 };
  const resizes: Recorded['resizes'] = { renderer: [], persona: [], hud: [] };
  const renderInputs: Recorded['renderInputs'] = [];
  const setOptions: Array<Record<string, unknown>> = [];
  const trackerOpts: Array<Record<string, unknown>> = [];
  const trackerInfo = fakeTrackerInfo();
  const hudOpts: Array<HudFactoryOptions | null> = [];
  const hudSetOptions: Array<{ reducedMotion: boolean; debugLandmarks: boolean }> = [];
  const hudExtras: HudExtras[] = [];
  const hudBuildArgs: Recorded['hudBuildArgs'] = [];
  const personaLooks: Array<LookSettings | undefined> = [];
  const personaReducedMotion: boolean[] = [];
  const warmed: Array<readonly StylePreset[]> = [];
  const rendererExt: Recorded['rendererExt'] = { contextLost: false, contextLossCount: 0, debug: { internalWidth: 1600, internalHeight: 900, maskFormat: 'R8' } };
  const rendererStats = { lastFrameMs: 0, passes: 0, gpuMs: null as number | null };
  const recorded = { personaInvalidates: 0 };

  const factories: RuntimeFactories = {
    createTracker: (opts, onProgress) => {
      trackerOpts.push((opts ?? {}) as Record<string, unknown>);
      const t = createStubTracker(opts, onProgress);
      return {
        init: () => t.init(),
        get ready() {
          return t.ready;
        },
        update: (v, time) => {
          calls.push('tracker.update');
          return t.update(v, time);
        },
        setOptions: (p) => {
          setOptions.push(p as Record<string, unknown>);
          t.setOptions(p);
        },
        getInfo: () => trackerInfo,
        dispose: () => {
          disposed.tracker += 1;
          t.dispose();
        },
      };
    },
    createRenderer: () => {
      const r = createStubRenderer();
      return {
        init: (c) => r.init(c),
        stats: rendererStats,
        get canvas() {
          return r.canvas;
        },
        get contextLost() {
          return rendererExt.contextLost;
        },
        get contextLossCount() {
          return rendererExt.contextLossCount;
        },
        getDebug: () => rendererExt.debug,
        warm: (presets: readonly StylePreset[]) => {
          calls.push('renderer.warm');
          warmed.push(presets);
        },
        resize: (w, h, d) => {
          resizes.renderer.push([w, h, d]);
          r.resize(w, h, d);
        },
        render: (inputs) => {
          calls.push('renderer.render');
          renderInputs.push(inputs);
          r.render(inputs);
        },
        dispose: () => {
          disposed.renderer += 1;
          r.dispose();
        },
      };
    },
    stylePresets: STUB_STYLE_PRESETS,
    presetForLayer: stubPresetForLayer,
    warmPresets: [STUB_STYLE_PRESETS['paper-portrait'], STUB_STYLE_PRESETS.comic],
    debugDraw: null,
    createPersonaLayer: () => {
      const p = createStubPersonaLayer();
      return {
        overlay: p.overlay,
        backdrop: p.backdrop,
        get personaId() {
          return p.personaId;
        },
        resize: (s) => {
          resizes.persona.push(s);
          p.resize(s);
        },
        update: (fr, sc, t, look) => {
          calls.push('persona.update');
          personaLooks.push(look);
          p.update(fr, sc, t);
        },
        setReducedMotion: (v) => {
          personaReducedMotion.push(v);
        },
        invalidate: () => {
          recorded.personaInvalidates += 1;
        },
      };
    },
    createInteraction: () => {
      const i = createStubInteraction();
      return {
        update: (fr, t, sc, st) => {
          calls.push('interaction.update');
          return i.update(fr, t, sc, st);
        },
        reset: () => {
          calls.push('interaction.reset');
          i.reset();
        },
      };
    },
    createDirector: (seq) => {
      const d = createStubDirector(seq);
      return {
        start: (t) => d.start(t),
        stop: () => d.stop(),
        get running() {
          return d.running;
        },
        update: (t) => {
          calls.push('director.update');
          return d.update(t);
        },
      };
    },
    createHud: (opts) => {
      hudOpts.push(opts ?? null);
      const h = createStubHud();
      return {
        canvas: h.canvas,
        setOptions: (o: { reducedMotion: boolean; debugLandmarks: boolean }) => {
          hudSetOptions.push(o);
        },
        resize: (s) => {
          resizes.hud.push(s);
          h.resize(s);
        },
        buildModel: (...a) => {
          calls.push('hud.buildModel');
          hudExtras.push(a[4]);
          hudBuildArgs.push({ frame: a[0] ? 'frame' : null, quad: a[1] ? 'quad' : null });
          return h.buildModel(...a);
        },
        draw: (m) => {
          calls.push('hud.draw');
          h.draw(m);
        },
      };
    },
    createRecorder: createStubRecorder,
    createPerfMonitor: () => {
      const p = createStubPerfMonitor();
      return {
        fps: () => p.fps(),
        recent: (ms) => p.recent(ms),
        sample: (s) => {
          calls.push('perf.sample');
          p.sample(s);
        },
      };
    },
    adaptivePolicy: stubAdaptivePolicy,
    ...overrides,
  };
  return {
    calls,
    factories,
    disposed,
    resizes,
    renderInputs,
    setOptions,
    trackerOpts,
    trackerInfo,
    hudOpts,
    hudSetOptions,
    hudExtras,
    hudBuildArgs,
    personaLooks,
    personaReducedMotion,
    get personaInvalidates() {
      return recorded.personaInvalidates;
    },
    warmed,
    rendererExt,
    rendererStats,
  };
}

export async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
