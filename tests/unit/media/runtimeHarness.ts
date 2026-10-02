/**
 * Shared fakes for the runtime-loop tests: an in-memory AppStore, a fake
 * FrameSource and factory wrappers that record call order.
 */
import { create } from 'zustand';
import type {
  AppState,
  AppStore,
  FrameSource,
  SourceStatus,
  TrackingFrame,
  HandTrack,
  Vec2,
} from '@/types';
import { DEFAULT_INTERACTION_SETTINGS, DEFAULT_QUALITY, DEFAULT_SCENE, PERSONA_ORDER } from '@/types';
import type { RuntimeFactories, HudFactoryOptions } from '@/runtime/factories';
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
    fps: 0,
    recorderState: 'idle',
    recorderElapsedMs: 0,
    setSession: (partial) => set(partial),
  }));
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
  private frameListeners = new Set<(t: number, meta: { presentedFrames: number }) => void>();
  private statusListeners = new Set<(s: SourceStatus, e: string | null) => void>();
  constructor(public autoReady = true) {}
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

export function fakeCanvas(cssW = 800, cssH = 450): HTMLCanvasElement {
  return { width: 300, height: 150, clientWidth: cssW, clientHeight: cssH } as unknown as HTMLCanvasElement;
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

export interface Recorded {
  calls: string[];
  factories: RuntimeFactories;
  disposed: { tracker: number; renderer: number };
  resizes: { renderer: Array<[number, number, number]>; persona: Array<{ width: number; height: number }>; hud: Array<{ width: number; height: number }> };
  renderInputs: Parameters<RuntimeFactories['createRenderer'] extends () => infer R ? (R extends { render: infer F } ? F : never) : never>[0][];
  setOptions: Array<Record<string, unknown>>;
  hudOpts: Array<HudFactoryOptions | null>;
  hudSetOptions: Array<{ reducedMotion: boolean; debugLandmarks: boolean }>;
}

/** Wraps the stub factories so every module call is logged in order. */
export function recordingFactories(overrides: Partial<RuntimeFactories> = {}): Recorded {
  const calls: string[] = [];
  const disposed = { tracker: 0, renderer: 0 };
  const resizes: Recorded['resizes'] = { renderer: [], persona: [], hud: [] };
  const renderInputs: Recorded['renderInputs'] = [];
  const setOptions: Array<Record<string, unknown>> = [];
  const hudOpts: Array<HudFactoryOptions | null> = [];
  const hudSetOptions: Array<{ reducedMotion: boolean; debugLandmarks: boolean }> = [];

  const factories: RuntimeFactories = {
    createTracker: (opts, onProgress) => {
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
        stats: r.stats,
        get canvas() {
          return r.canvas;
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
        update: (fr, sc, t) => {
          calls.push('persona.update');
          p.update(fr, sc, t);
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
  return { calls, factories, disposed, resizes, renderInputs, setOptions, hudOpts, hudSetOptions };
}

export async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
