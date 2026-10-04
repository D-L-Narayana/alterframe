import { describe, it, expect, vi, afterEach } from 'vitest';
import { startRuntime, getActiveRuntime, subscribeRuntime, DEV_BRIDGE_ENABLED, type AlterFrameRuntime } from '@/runtime';
import { resolveFactories } from '@/runtime/factories';
import { computeGlitch } from '@/runtime/glitch';
import type { QualitySettings, WindowQuad } from '@/types';
import { FakeSource, fakeCanvas, fakeEnv, flush, frameWithHands, makeStore, recordingFactories } from './runtimeHarness';

const quad = (thickness: number, visible = true): WindowQuad => ({
  corners: [
    { x: 0.3, y: 0.3 },
    { x: 0.7, y: 0.3 },
    { x: 0.7, y: 0.6 },
    { x: 0.3, y: 0.6 },
  ],
  opacity: 1,
  thickness,
  area: 0.12,
  centroid: { x: 0.5, y: 0.45 },
  visible,
  ordering: 'convex',
});

let handles: AlterFrameRuntime[] = [];
afterEach(() => {
  for (const h of handles) h.stop();
  handles = [];
  vi.useRealTimers();
});

async function boot(opts: { source?: FakeSource; store?: ReturnType<typeof makeStore>; canvas?: HTMLCanvasElement; dpr?: number; factoryOverrides?: Parameters<typeof recordingFactories>[0] } = {}) {
  const source = opts.source ?? new FakeSource();
  const store = opts.store ?? makeStore();
  const canvas = opts.canvas ?? fakeCanvas();
  const rec = recordingFactories(opts.factoryOverrides);
  const fe = fakeEnv(opts.dpr ?? 2);
  const handle = startRuntime({ canvas, store, source }, { factories: rec.factories, env: fe.env, sessionSyncMs: 0, adaptiveIntervalMs: 0 });
  handles.push(handle);
  await handle.ready;
  await handle.trackerReady;
  await flush();
  return { handle, source, store, canvas, rec, setNow: fe.setNow };
}

describe('computeGlitch', () => {
  // The setting is typed on SettingsSlice; the default (false) keeps the slit effect off.
  const base = { reducedMotion: false, thinStripGlitch: false };
  it('is 0 by default (slit static is not a glitch)', () => {
    expect(computeGlitch(quad(0.001), base)).toBe(0);
  });
  it('follows clamp(1 - thickness/0.04) only when thinStripGlitch is enabled', () => {
    const on = { reducedMotion: false, thinStripGlitch: true };
    expect(computeGlitch(quad(0), on)).toBe(1);
    expect(computeGlitch(quad(0.02), on)).toBeCloseTo(0.5);
    expect(computeGlitch(quad(0.1), on)).toBe(0);
    expect(computeGlitch(quad(0.02, false), on)).toBe(0);
    expect(computeGlitch(null, on)).toBe(0);
  });
  it('is 0 under reduced motion even when enabled', () => {
    expect(computeGlitch(quad(0), { reducedMotion: true, thinStripGlitch: true })).toBe(0);
  });
});

describe('resolveFactories', () => {
  it('prefers overrides, then real modules, then stubs; reports stubbed names', () => {
    const rec = recordingFactories();
    const { factories, stubbed } = resolveFactories(rec.factories);
    expect(stubbed).toEqual([]);
    expect(factories.createTracker).toBe(rec.factories.createTracker);
    const auto = resolveFactories();
    // Whatever has landed from other workers is real; the rest is stub — but every slot is filled.
    for (const key of Object.keys(auto.factories) as Array<keyof typeof auto.factories>) expect(auto.factories[key]).toBeTruthy();
    expect(new Set(auto.stubbed).size).toBe(auto.stubbed.length);
  });
});

describe('startRuntime loop', () => {
  it('starts an idle source, mirrors its status into the store and registers itself', async () => {
    const { handle, source, store } = await boot();
    expect(source.startCalls).toBe(1);
    expect(store.getState().sourceStatus).toBe('ready');
    expect(store.getState().sourceKind).toBe('camera');
    expect(store.getState().trackerReady).toBe(true);
    expect(getActiveRuntime()).toBe(handle);
    expect(handle.modules.stubbed).toEqual([]);
  });

  it('does not call start() on a source that is already ready', async () => {
    const source = new FakeSource();
    source.status = 'ready';
    await boot({ source });
    expect(source.startCalls).toBe(0);
  });

  it('calls modules in contract order per video frame', async () => {
    const { source, rec, handle } = await boot();
    rec.calls.length = 0;
    source.emitFrame(16);
    // (renderer.warm runs in idle time, not per frame — see runtimeFeatures.test.ts.)
    expect(rec.calls).toEqual([
      'tracker.update',
      'interaction.update',
      'persona.update',
      'hud.buildModel',
      'hud.draw',
      'renderer.render',
      'perf.sample',
    ]);
    expect(handle.frameCount).toBe(1);
    expect(handle.getStats().fps).toBeGreaterThanOrEqual(0);
  });

  it('director.update runs only while the Director is running, between interaction and persona', async () => {
    const { source, rec, store } = await boot();
    source.emitFrame(16);
    expect(rec.calls.filter((c) => c === 'director.update')).toHaveLength(0);
    store.getState().setDirectorRunning(true);
    rec.calls.length = 0;
    source.emitFrame(33);
    expect(rec.calls.indexOf('director.update')).toBe(rec.calls.indexOf('interaction.update') + 1);
    expect(rec.calls.indexOf('director.update')).toBe(rec.calls.indexOf('persona.update') - 1);
  });

  it('passes intrinsic video size to overlays and CSS×dpr (capped by maxDpr) to the renderer', async () => {
    const source = new FakeSource();
    source.video = { videoWidth: 640, videoHeight: 480 } as unknown as HTMLVideoElement;
    const { rec, store } = await boot({ source, canvas: fakeCanvas(390, 844), dpr: 3 });
    expect(store.getState().quality.maxDpr).toBe(2);
    expect(rec.resizes.renderer.at(-1)).toEqual([390, 844, 2]);
    expect(rec.resizes.persona.at(-1)).toEqual({ width: 640, height: 480 });
    expect(rec.resizes.hud.at(-1)).toEqual({ width: 640, height: 480 });
    source.emitFrame(16);
    const inputs = rec.renderInputs.at(-1)!;
    expect(inputs.videoWidth).toBe(640);
    expect(inputs.videoHeight).toBe(480);
    expect(inputs.mirrored).toBe(true);
    expect(inputs.glitch).toBe(0);
    expect(inputs.time).toBeCloseTo(0.016);
  });

  it('re-sizes when the canvas CSS size changes between frames', async () => {
    const canvas = fakeCanvas(800, 450);
    const { source, rec } = await boot({ canvas });
    const before = rec.resizes.renderer.length;
    (canvas as unknown as { clientWidth: number }).clientWidth = 1000;
    source.emitFrame(16);
    expect(rec.resizes.renderer.length).toBe(before + 1);
    expect(rec.resizes.renderer.at(-1)).toEqual([1000, 450, 2]);
  });

  it('skips frames until the video has dimensions', async () => {
    const source = new FakeSource();
    source.video = { videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement;
    source.width = 0;
    source.height = 0;
    const { rec } = await boot({ source });
    rec.calls.length = 0;
    source.emitFrame(16);
    expect(rec.calls).toEqual([]);
  });

  it('chooses paper-portrait for portrait and comic for masked/suit; comic base only when scene.base is comic', async () => {
    const { source, rec, store } = await boot();
    source.emitFrame(16);
    let inputs = rec.renderInputs.at(-1)!;
    expect(inputs.windowStyle.id).toBe('paper-portrait');
    expect(inputs.baseStyle).toBeNull();
    store.getState().setScene({ base: 'comic', persona: 'masked' });
    source.emitFrame(33);
    inputs = rec.renderInputs.at(-1)!;
    expect(inputs.windowStyle.id).toBe('comic');
    expect(inputs.windowStyle.usesBackdrop).toBe(true);
    expect(inputs.baseStyle?.id).toBe('comic');
    // Base comic keeps the real room: no backdrop replacement on the base layer.
    expect(inputs.baseStyle?.usesBackdrop).toBe(false);
    expect(inputs.scene.hudTint).toBe('red');
    expect(inputs.personaBackdrop).not.toBeNull();
  });

  it('creates the HUD with store options and forwards reducedMotion/debugLandmarks changes once', async () => {
    const { source, rec, store } = await boot();
    expect(rec.hudOpts[0]).toMatchObject({ reducedMotion: false, debugLandmarks: false });
    source.emitFrame(16);
    expect(rec.hudSetOptions).toEqual([]);
    store.getState().setSettings({ debugLandmarks: true });
    source.emitFrame(33);
    source.emitFrame(50);
    expect(rec.hudSetOptions).toEqual([{ reducedMotion: false, debugLandmarks: true }]);
  });

  it('omits the HUD overlay when hudEnabled is false', async () => {
    const { source, rec, store } = await boot();
    store.getState().setSettings({ hudEnabled: false });
    rec.calls.length = 0;
    source.emitFrame(16);
    expect(rec.calls).not.toContain('hud.draw');
    expect(rec.renderInputs.at(-1)!.hudOverlay).toBeNull();
  });

  it('forwards mirrored / segmentationStride changes to tracker.setOptions once (changed keys only)', async () => {
    const { source, rec, store } = await boot();
    source.emitFrame(16);
    expect(rec.setOptions).toEqual([]);
    store.getState().setSettings({ mirrored: false });
    source.emitFrame(33);
    source.emitFrame(50);
    // v0.2: only the keys that changed travel (inferenceMaxHeight/faceStride join the set; see runtimeFeatures.test.ts).
    expect(rec.setOptions).toEqual([{ mirrored: false }]);
    expect(rec.renderInputs.at(-1)!.mirrored).toBe(false);
  });

  it('applies cycle-persona events to the store (not while the Director runs)', async () => {
    const events = [{ type: 'cycle-persona' as const, next: 'masked' as const }];
    const { source, store } = await boot({
      factoryOverrides: {
        createInteraction: () => ({ update: () => ({ quad: null, events, debug: { armed: false, togetherMs: 0, handsUsed: 2 } }), reset: () => {} }),
      },
    });
    source.emitFrame(16);
    expect(store.getState().scene.persona).toBe('masked');
    store.getState().setDirectorRunning(true);
    source.emitFrame(33);
    // Director took over at t=33 (step 0 = portrait) and the gesture is ignored.
    expect(store.getState().scene.persona).toBe('portrait');
  });

  it('tracks window-open/close events', async () => {
    let type: 'window-open' | 'window-close' = 'window-open';
    const { source, handle } = await boot({
      factoryOverrides: {
        createInteraction: () => ({ update: () => ({ quad: null, events: [{ type }], debug: { armed: false, togetherMs: 0, handsUsed: 0 } }), reset: () => {} }),
      },
    });
    source.emitFrame(16);
    expect(handle.windowOpen).toBe(true);
    type = 'window-close';
    source.emitFrame(33);
    expect(handle.windowOpen).toBe(false);
  });

  it('Director: snapshots the scene on start, drives base/persona through setScene, restores on stop', async () => {
    const { source, store } = await boot();
    store.getState().setScene({ base: 'comic', persona: 'suit' });
    store.getState().setDirectorRunning(true);
    source.emitFrame(1000);
    expect(store.getState().scene).toEqual({ base: 'live', persona: 'portrait', hudTint: 'white' });
    source.emitFrame(1000 + 13800 + 100); // step 1: live/masked
    expect(store.getState().scene.persona).toBe('masked');
    source.emitFrame(1000 + 13800 + 1600 + 100); // step 2: comic/masked → hudTint derived by store
    expect(store.getState().scene).toEqual({ base: 'comic', persona: 'masked', hudTint: 'red' });
    store.getState().setDirectorRunning(false);
    source.emitFrame(1000 + 20000);
    expect(store.getState().scene).toEqual({ base: 'comic', persona: 'suit', hudTint: 'red' });
  });

  it('adaptive quality writes the policy result into settings', async () => {
    const lowered: QualitySettings = { renderScale: 0.85, maxDpr: 2, segmentationStride: 1, inferenceMaxHeight: 720, faceStride: 1 };
    const { source, store } = await boot({ factoryOverrides: { adaptivePolicy: { evaluate: (_s, cur) => (cur.renderScale === 1 ? lowered : null) } } });
    source.emitFrame(16);
    expect(store.getState().quality).toEqual(lowered);
    source.emitFrame(33);
    expect(store.getState().quality).toEqual(lowered);
  });

  it('does not touch quality when adaptiveQuality is off', async () => {
    const lowered: QualitySettings = { renderScale: 0.85, maxDpr: 2, segmentationStride: 1, inferenceMaxHeight: 720, faceStride: 1 };
    const { source, store } = await boot({ factoryOverrides: { adaptivePolicy: { evaluate: () => lowered } } });
    store.getState().setSettings({ adaptiveQuality: false });
    source.emitFrame(16);
    expect(store.getState().quality.renderScale).toBe(1);
  });

  it('syncs fps and recorder state into the session slice', async () => {
    const { source, store, handle, setNow } = await boot();
    setNow(0);
    source.emitFrame(0);
    setNow(16);
    source.emitFrame(16);
    expect(store.getState().fps).toBeGreaterThanOrEqual(0);
    await handle.recorder.start({ aspect: 'source' });
    source.emitFrame(33);
    expect(store.getState().recorderState).toBe('recording');
    await handle.recorder.stop();
    source.emitFrame(50);
    expect(store.getState().recorderState).toBe('idle');
    expect(store.getState().recorderElapsedMs).toBe(0);
  });

  it('snapshot() delegates to the recorder', async () => {
    const { handle } = await boot();
    const blob = await handle.snapshot('9:16');
    expect(blob).toBeInstanceOf(Blob);
  });

  it('injectTracking (dev/test gate) replaces tracker output until cleared', async () => {
    const { source, rec, handle } = await boot();
    expect(DEV_BRIDGE_ENABLED).toBe(true);
    expect(handle.injectionEnabled).toBe(true);
    expect(typeof handle.injectTracking).toBe('function');
    handle.injectTracking!(frameWithHands(16));
    rec.calls.length = 0;
    source.emitFrame(16);
    expect(rec.calls).not.toContain('tracker.update');
    const inputs = rec.renderInputs.at(-1)!;
    expect(inputs.tracking?.hands).toHaveLength(2);
    expect(inputs.quad?.visible).toBe(true);
    // Stub interaction builds the quad straight from the (video-space) tips — no remap by the runtime.
    expect(inputs.quad?.corners[0]).toEqual({ x: 0.3, y: 0.3 });
    handle.injectTracking!(null);
    rec.calls.length = 0;
    source.emitFrame(33);
    expect(rec.calls).toContain('tracker.update');
  });

  it('stop() cancels frame callbacks, stops the source, disposes modules and clears the registry', async () => {
    const seen: Array<unknown> = [];
    const unsub = subscribeRuntime((h) => seen.push(h));
    const { handle, source, rec } = await boot();
    expect(source.frameListenerCount).toBe(1);
    handle.stop();
    expect(source.frameListenerCount).toBe(0);
    expect(source.stopCalls).toBe(1);
    expect(rec.disposed).toEqual({ tracker: 1, renderer: 1 });
    expect(getActiveRuntime()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    rec.calls.length = 0;
    source.emitFrame(99);
    expect(rec.calls).toEqual([]);
    handle.stop(); // idempotent
    expect(rec.disposed.tracker).toBe(1);
    unsub();
  });

  it('stop() before init completes leaves nothing running (StrictMode double effect)', async () => {
    const source = new FakeSource();
    const rec = recordingFactories();
    const handle = startRuntime({ canvas: fakeCanvas(), store: makeStore(), source }, { factories: rec.factories });
    handle.stop();
    await handle.ready;
    await handle.trackerReady;
    await flush();
    expect(source.frameListenerCount).toBe(0);
    expect(rec.disposed.tracker).toBe(1);
    expect(getActiveRuntime()).toBeNull();
  });

  it('setSource stops the old source, starts the new one and keeps rendering', async () => {
    const { handle, source, rec, store } = await boot();
    const next = new FakeSource();
    next.kind = 'file';
    next.video = { videoWidth: 1920, videoHeight: 1080 } as unknown as HTMLVideoElement;
    await handle.setSource(next);
    expect(source.stopCalls).toBe(1);
    expect(source.frameListenerCount).toBe(0);
    expect(next.startCalls).toBe(1);
    expect(store.getState().sourceKind).toBe('file');
    expect(store.getState().sourceStatus).toBe('ready');
    expect(rec.resizes.persona.at(-1)).toEqual({ width: 1920, height: 1080 });
    rec.calls.length = 0;
    next.emitFrame(16);
    expect(rec.calls).toContain('renderer.render');
    expect(handle.source).toBe(next);
  });

  it('a source that fails to start surfaces its status/error in the store without throwing', async () => {
    const source = new FakeSource(false);
    source.start = () => {
      source.startCalls += 1;
      source.setStatus('denied', 'Camera access was denied.');
      return Promise.reject(new Error('denied'));
    };
    const { store } = await boot({ source });
    expect(store.getState().sourceStatus).toBe('denied');
    expect(store.getState().sourceError).toBe('Camera access was denied.');
  });

  it('a tracker that fails to init does not break the loop; trackerError is exposed', async () => {
    const { source, rec, handle, store } = await boot({
      factoryOverrides: {
        createTracker: () => ({
          init: () => Promise.reject(new Error('wasm failed')),
          update: () => {
            throw new Error('never');
          },
          setOptions: () => {},
          ready: false,
          dispose: () => {},
        }),
      },
    });
    expect(handle.trackerError).toBe('wasm failed');
    expect(store.getState().trackerReady).toBe(false);
    rec.calls.length = 0;
    source.emitFrame(16);
    expect(rec.calls).toContain('renderer.render');
    expect(rec.renderInputs.at(-1)!.tracking).toBeNull();
  });

  it('a throwing frame handler is captured in lastError and the loop continues', async () => {
    let boom = true;
    const { source, handle, rec } = await boot({
      factoryOverrides: {
        createPersonaLayer: () => ({
          resize: () => {},
          update: () => {
            if (boom) throw new Error('persona exploded');
          },
          overlay: { width: 1, height: 1 } as unknown as HTMLCanvasElement,
          backdrop: { width: 1, height: 1 } as unknown as HTMLCanvasElement,
          personaId: 'portrait',
        }),
      },
    });
    source.emitFrame(16);
    expect(handle.lastError?.message).toBe('persona exploded');
    boom = false;
    rec.calls.length = 0;
    source.emitFrame(33);
    expect(rec.calls).toContain('renderer.render');
  });

  it('reports tracker progress to listeners', async () => {
    const { handle } = await boot();
    const seen: number[] = [];
    handle.onTrackerProgress((p) => seen.push(p));
    expect(seen).toEqual([1]);
  });
});
