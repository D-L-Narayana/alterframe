/**
 * v0.2 runtime-loop behaviour: session sync, handle methods (requestRender / retryTracker /
 * getDiagnostics), paused re-render, option/look forwarding, HUD extras, dwell → captureRequest,
 * shader warm-up. Node-side with fakes; no browser.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startRuntime, hudCountdown, type AlterFrameRuntime, type RuntimeOptions } from '@/runtime';
import type { InteractionEvent, InteractionOutput, Renderer, Tracker, TrackingFrame } from '@/types';
import { FakeSource, fakeCanvas, fakeEnv, flush, makeStore, recordingFactories, type FakeCanvas } from './runtimeHarness';

let handles: AlterFrameRuntime[] = [];
afterEach(() => {
  for (const h of handles) h.stop();
  handles = [];
  vi.useRealTimers();
});

interface BootOpts {
  source?: FakeSource;
  canvas?: FakeCanvas;
  factoryOverrides?: Parameters<typeof recordingFactories>[0];
  runtime?: Partial<RuntimeOptions>;
  /** Skip awaiting trackerReady (tests that drive tracker init themselves). */
  noTrackerWait?: boolean;
}

async function boot(opts: BootOpts = {}) {
  const source = opts.source ?? new FakeSource();
  const store = makeStore();
  const canvas = opts.canvas ?? fakeCanvas();
  const rec = recordingFactories(opts.factoryOverrides);
  const fe = fakeEnv();
  const handle = startRuntime({ canvas, store, source }, { factories: rec.factories, env: fe.env, sessionSyncMs: 0, adaptiveIntervalMs: 0, ...opts.runtime });
  handles.push(handle);
  await handle.ready;
  if (!opts.noTrackerWait) await handle.trackerReady;
  await flush();
  return { handle, source, store, canvas, rec, fe };
}

/** Interaction double that replays scripted events/debug values per frame. */
function scriptedInteraction(script: { events?: InteractionEvent[]; dwellProgress?: number }) {
  return {
    createInteraction: () => ({
      update: (): InteractionOutput => ({
        quad: null,
        events: script.events ?? [],
        debug: { armed: false, togetherMs: 0, handsUsed: 2, ...(script.dwellProgress !== undefined ? { dwellProgress: script.dwellProgress } : {}) },
      }),
      reset: () => {},
    }),
  };
}

/** Tracker double with a controllable init (progress reports, deferred settle, scripted failures). */
function controllableTracker(opts: { failures?: number } = {}) {
  let failures = opts.failures ?? 0;
  let ready = false;
  let progress: ((p: number) => void) | undefined;
  let settle: (() => void) | null = null;
  const inits: number[] = [];
  const tracker: Tracker = {
    init() {
      inits.push(1);
      return new Promise<void>((resolve, reject) => {
        settle = () => {
          settle = null;
          if (failures > 0) {
            failures -= 1;
            reject(new Error('model 404'));
          } else {
            progress?.(1);
            ready = true;
            resolve();
          }
        };
      });
    },
    update: (_v, t): TrackingFrame => ({ t, sourceWidth: 1280, sourceHeight: 720, hands: [], face: null, segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } }),
    setOptions: () => {},
    get ready() {
      return ready;
    },
    dispose: () => {
      ready = false;
    },
  };
  return {
    overrides: {
      createTracker: (_o: unknown, onProgress?: (p: number) => void) => {
        progress = onProgress;
        return tracker;
      },
    },
    report: (p: number) => progress?.(p),
    settle: () => settle?.(),
    get initCount() {
      return inits.length;
    },
  };
}

describe('requestRender', () => {
  it('renders exactly one frame now, re-using the last frame time plus a small epsilon', async () => {
    const { handle, source, rec } = await boot();
    source.emitFrame(100);
    rec.calls.length = 0;
    handle.requestRender();
    expect(rec.calls.filter((c) => c === 'renderer.render')).toHaveLength(1);
    expect(rec.calls).toEqual(['tracker.update', 'interaction.update', 'persona.update', 'hud.buildModel', 'hud.draw', 'renderer.render', 'perf.sample']);
    const t = rec.renderInputs.at(-1)!.time * 1000;
    expect(t).toBeGreaterThan(100);
    expect(t).toBeLessThan(101);
    expect(handle.frameCount).toBe(2);
    // Repeated requests do not drift the clock.
    handle.requestRender();
    expect(rec.renderInputs.at(-1)!.time * 1000).toBeCloseTo(t, 9);
  });

  it('is a no-op before the renderer is ready and after stop()', async () => {
    const source = new FakeSource();
    const rec = recordingFactories();
    const handle = startRuntime({ canvas: fakeCanvas(), store: makeStore(), source }, { factories: rec.factories, env: fakeEnv().env });
    handles.push(handle);
    handle.requestRender();
    expect(rec.calls).not.toContain('renderer.render');
    await handle.ready;
    await handle.trackerReady;
    await flush();
    handle.stop();
    rec.calls.length = 0;
    handle.requestRender();
    expect(rec.calls).toEqual([]);
  });
});

describe('retryTracker', () => {
  it('resets progress and error, re-runs init and marks the tracker ready on success', async () => {
    const ct = controllableTracker({ failures: 1 });
    const { handle, store } = await boot({ factoryOverrides: ct.overrides, noTrackerWait: true });
    ct.report(0.4);
    ct.settle(); // first init fails
    await handle.trackerReady;
    await flush();
    expect(store.getState().trackerError).toBe('model 404');
    expect(store.getState().trackerReady).toBe(false);
    expect(store.getState().trackerProgress).toBe(0.4);
    expect(handle.trackerError).toBe('model 404');

    const seen: number[] = [];
    handle.onTrackerProgress((p) => seen.push(p));
    const retry = handle.retryTracker();
    expect(store.getState().trackerError).toBeNull();
    expect(store.getState().trackerProgress).toBe(0);
    expect(seen).toEqual([0.4, 0]);
    expect(ct.initCount).toBe(2);
    await flush();
    ct.settle(); // second init succeeds
    await retry;
    expect(store.getState().trackerReady).toBe(true);
    expect(store.getState().trackerProgress).toBe(1);
    expect(store.getState().trackerError).toBeNull();
    expect(handle.trackerProgress).toBe(1);
  });

  it('never rejects: a second failure leaves trackerError set', async () => {
    const ct = controllableTracker({ failures: 2 });
    const { handle, store } = await boot({ factoryOverrides: ct.overrides, noTrackerWait: true });
    ct.settle();
    await handle.trackerReady;
    const retry = handle.retryTracker();
    await flush();
    ct.settle();
    await expect(retry).resolves.toBeUndefined();
    expect(store.getState().trackerError).toBe('model 404');
    expect(store.getState().trackerReady).toBe(false);
  });

  it('is a no-op after stop()', async () => {
    const ct = controllableTracker();
    const { handle } = await boot({ factoryOverrides: ct.overrides, noTrackerWait: true });
    ct.settle();
    await handle.trackerReady;
    handle.stop();
    await expect(handle.retryTracker()).resolves.toBeUndefined();
    expect(ct.initCount).toBe(1);
  });
});

describe('getDiagnostics', () => {
  it('reports timings, tracker info, renderer extension, quality, source and modules as plain data', async () => {
    const { handle, source, rec, store, fe } = await boot();
    rec.rendererStats.gpuMs = 2.5;
    fe.setNow(0);
    source.emitFrame(0);
    fe.setNow(16);
    source.emitFrame(16);
    const d = handle.getDiagnostics();
    expect(d.frames).toBe(2);
    expect(d.gpuMs).toBe(2.5);
    expect(d.fps).toBe(handle.getStats().fps);
    expect(d.tracker).toEqual({ ready: true, progress: 1, error: null, delegates: { hands: 'GPU', face: 'GPU', segmentation: 'CPU' }, inferenceSize: { width: 1280, height: 720 }, warnings: ['[tracking] test warning'] });
    expect(d.renderer).toEqual({ contextLost: false, contextLossCount: 0, internal: { width: 1600, height: 900 }, maskFormat: 'R8' });
    expect(d.quality).toEqual(store.getState().quality);
    expect(d.quality).not.toBe(store.getState().quality);
    expect(d.source).toEqual({ kind: 'camera', status: 'ready', width: 1280, height: 720 });
    expect(d.modules).toEqual({ stubbed: [] });
    expect(() => JSON.stringify(d)).not.toThrow();
    // Warnings are a copy, not the tracker's live array.
    d.tracker.warnings.push('x');
    expect(rec.trackerInfo.warnings).toHaveLength(1);
  });

  it('degrades to nulls when the renderer has no extension and the tracker has no getInfo', async () => {
    const plainRenderer = (): Renderer => ({
      init: async () => {},
      resize: () => {},
      render: () => {},
      canvas: fakeCanvas(),
      stats: { lastFrameMs: 0, passes: 0, gpuMs: null },
      dispose: () => {},
    });
    const plainTracker = (): Tracker => ({ init: async () => {}, update: () => ({ t: 0, sourceWidth: 1, sourceHeight: 1, hands: [], face: null, segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } }), setOptions: () => {}, ready: false, dispose: () => {} });
    const { handle } = await boot({ factoryOverrides: { createRenderer: plainRenderer, createTracker: plainTracker } });
    const d = handle.getDiagnostics();
    expect(d.renderer).toBeNull();
    expect(d.gpuMs).toBeNull();
    expect(d.tracker.delegates).toBeNull();
    expect(d.tracker.inferenceSize).toBeNull();
    expect(d.tracker.warnings).toEqual([]);
    expect(d.tracker.ready).toBe(false);
  });
});

describe('session sync', () => {
  it('mirrors windowOpen into the store from interaction events (handle getter reads the store)', async () => {
    let type: 'window-open' | 'window-close' = 'window-open';
    const { source, store, handle } = await boot({
      factoryOverrides: {
        createInteraction: () => ({ update: (): InteractionOutput => ({ quad: null, events: [{ type }], debug: { armed: false, togetherMs: 0, handsUsed: 0 } }), reset: () => {} }),
      },
    });
    source.emitFrame(16);
    expect(store.getState().windowOpen).toBe(true);
    expect(handle.windowOpen).toBe(true);
    type = 'window-close';
    source.emitFrame(33);
    expect(store.getState().windowOpen).toBe(false);
    expect(handle.windowOpen).toBe(false);
  });

  it('mirrors contextLost each frame and invalidates the persona once the context is back', async () => {
    const { source, store, rec } = await boot();
    source.emitFrame(16);
    expect(store.getState().contextLost).toBe(false);
    rec.rendererExt.contextLost = true;
    rec.rendererExt.contextLossCount = 1;
    source.emitFrame(33);
    expect(store.getState().contextLost).toBe(true);
    expect(rec.personaInvalidates).toBe(0);
    rec.rendererExt.contextLost = false;
    source.emitFrame(50);
    expect(store.getState().contextLost).toBe(false);
    expect(rec.personaInvalidates).toBe(1);
    source.emitFrame(66);
    expect(rec.personaInvalidates).toBe(1);
  });

  it('throttles trackerProgress writes to ≤ 10 Hz with a trailing flush, and writes 1 with trackerReady', async () => {
    vi.useFakeTimers();
    const ct = controllableTracker();
    const { store, fe, handle } = await boot({ factoryOverrides: ct.overrides, noTrackerWait: true });
    const writes: number[] = [];
    store.subscribe((s, p) => {
      if (s.trackerProgress !== p.trackerProgress) writes.push(s.trackerProgress);
    });
    fe.setNow(1000);
    ct.report(0.1);
    ct.report(0.2);
    ct.report(0.3);
    expect(writes).toEqual([0.1]); // first value immediately, the burst is coalesced
    expect(handle.trackerProgress).toBe(0.3);
    fe.setNow(1100);
    await vi.advanceTimersByTimeAsync(100);
    expect(writes).toEqual([0.1, 0.3]); // trailing flush carries the latest value
    fe.setNow(1150);
    ct.report(0.5);
    expect(writes).toEqual([0.1, 0.3]); // 50 ms after the last write: deferred
    fe.setNow(1250);
    ct.report(0.6);
    expect(writes).toEqual([0.1, 0.3, 0.6]); // ≥ 100 ms: immediate (pending timer dropped)
    await vi.advanceTimersByTimeAsync(200);
    expect(writes).toEqual([0.1, 0.3, 0.6]);
    ct.settle();
    await handle.trackerReady;
    expect(writes.at(-1)).toBe(1);
    expect(store.getState().trackerReady).toBe(true);
  });

  it('mirrors the file transport on every session sync and immediately on transport events; camera sources keep null', async () => {
    const cam = await boot();
    cam.source.emitFrame(16);
    expect(cam.store.getState().transport).toBeNull();

    const source = new FakeSource();
    const tr = source.withTransport();
    const { store, rec } = await boot({ source });
    expect(store.getState().transport).toEqual({ paused: true, currentTime: 0, duration: 10, loop: true });
    expect(tr.listenerCount).toBe(1);
    const before = store.getState().transport;
    source.emitFrame(16);
    expect(store.getState().transport).toBe(before); // unchanged → same object (no spurious writes)
    tr.currentTime = 2.5; // playback advanced without an event: picked up by the periodic sync
    source.emitFrame(33);
    expect(store.getState().transport?.currentTime).toBe(2.5);
    rec.calls.length = 0;
    await tr.play();
    expect(store.getState().transport?.paused).toBe(false);
    tr.pause();
    expect(store.getState().transport?.paused).toBe(true);
    tr.seek(4);
    expect(store.getState().transport?.currentTime).toBe(4);
    tr.setLoop(false);
    expect(store.getState().transport?.loop).toBe(false);
    // Each transport event re-renders once so a paused clip shows the new position.
    expect(rec.calls.filter((c) => c === 'renderer.render')).toHaveLength(4);
  });

  it('mirrors a seek into the store at once but skips the immediate re-render while the element is still seeking (old frame); the seeked notification renders the new one', async () => {
    const source = new FakeSource();
    const tr = source.withTransport();
    const { store, rec } = await boot({ source });
    const video = source.video as unknown as { seeking?: boolean };
    rec.calls.length = 0;
    video.seeking = true;
    tr.seek(3); // synchronous notification from the command: the element has not presented the new frame yet
    expect(store.getState().transport?.currentTime).toBe(3);
    expect(rec.calls).not.toContain('renderer.render');
    video.seeking = false;
    tr.fire(); // the element's `seeked` event
    expect(rec.calls.filter((c) => c === 'renderer.render')).toHaveLength(1);
  });

  it('clears windowOpen / transport / contextLost on stop() and unsubscribes from the transport', async () => {
    const source = new FakeSource();
    const tr = source.withTransport();
    const { handle, store, rec } = await boot({ source, factoryOverrides: scriptedInteraction({ events: [{ type: 'window-open' }] }) });
    rec.rendererExt.contextLost = true;
    source.emitFrame(16);
    expect(store.getState().windowOpen).toBe(true);
    expect(store.getState().contextLost).toBe(true);
    handle.stop();
    expect(store.getState().windowOpen).toBe(false);
    expect(store.getState().transport).toBeNull();
    expect(store.getState().contextLost).toBe(false);
    expect(tr.listenerCount).toBe(0);
  });

  it('syncs the transport of a source swapped in with setSource', async () => {
    const { handle, store } = await boot();
    const next = new FakeSource();
    const tr = next.withTransport();
    await handle.setSource(next);
    expect(store.getState().transport).toEqual(tr.state());
    const cam = new FakeSource();
    await handle.setSource(cam);
    expect(store.getState().transport).toBeNull();
    expect(tr.listenerCount).toBe(0);
  });
});

describe('paused re-render', () => {
  it('schedules exactly one render per store-change burst when no video frame arrived in the last 250 ms', async () => {
    const { source, store, rec, fe } = await boot();
    fe.setNow(1000);
    source.emitFrame(1000);
    fe.setNow(1300); // paused: last frame 300 ms ago
    rec.calls.length = 0;
    store.getState().setScene({ persona: 'masked' });
    store.getState().setSettings({ look: { ...store.getState().look, inkWidth: 2 } });
    store.getState().setSettings({ fitMode: 'contain' });
    expect(rec.calls).toEqual([]); // nothing synchronous
    expect(fe.rafPending).toBe(1);
    fe.flushRaf();
    expect(rec.calls.filter((c) => c === 'renderer.render')).toHaveLength(1);
    const inputs = rec.renderInputs.at(-1)!;
    expect(inputs.scene.persona).toBe('masked');
    expect(inputs.fitMode).toBe('contain');
    expect(inputs.look?.inkWidth).toBe(2);
    expect(inputs.time * 1000).toBeGreaterThan(1000);
    expect(fe.rafPending).toBe(0);
  });

  it('does nothing while frames are flowing or when only runtime-owned session fields change', async () => {
    const { source, store, fe } = await boot();
    fe.setNow(1000);
    source.emitFrame(1000);
    fe.setNow(1100);
    store.getState().setScene({ persona: 'suit' });
    expect(fe.rafPending).toBe(0);
    fe.setNow(2000);
    store.getState().setSession({ fps: 42, recorderElapsedMs: 10 });
    expect(fe.rafPending).toBe(0);
  });

  it('skips the scheduled render when a video frame arrives before the animation frame', async () => {
    const { source, store, rec, fe } = await boot();
    fe.setNow(1000);
    source.emitFrame(1000);
    fe.setNow(1500);
    store.getState().setScene({ base: 'comic' });
    expect(fe.rafPending).toBe(1);
    fe.setNow(1510);
    source.emitFrame(1510); // playback resumed: this frame already shows the change
    rec.calls.length = 0;
    fe.flushRaf();
    expect(rec.calls).toEqual([]);
  });

  it('re-renders after webglcontextrestored while the source is paused, and cancels the pending frame on stop()', async () => {
    const canvas = fakeCanvas();
    const { source, rec, fe, handle, store } = await boot({ canvas });
    expect(canvas.listenerCount('webglcontextrestored')).toBe(1);
    expect(canvas.listenerCount('webglcontextlost')).toBe(1);
    fe.setNow(1000);
    source.emitFrame(1000);
    rec.rendererExt.contextLost = true;
    canvas.dispatch('webglcontextlost');
    expect(store.getState().contextLost).toBe(true); // noticed without a frame
    fe.setNow(3000);
    rec.rendererExt.contextLost = false;
    rec.calls.length = 0;
    canvas.dispatch('webglcontextrestored');
    expect(fe.rafPending).toBe(1);
    fe.flushRaf();
    expect(rec.calls.filter((c) => c === 'renderer.render')).toHaveLength(1);
    expect(store.getState().contextLost).toBe(false);
    expect(rec.personaInvalidates).toBe(1);
    fe.setNow(5000);
    store.getState().setScene({ persona: 'masked' });
    expect(fe.rafPending).toBe(1);
    handle.stop();
    expect(fe.rafPending).toBe(0);
    expect(canvas.listenerCount('webglcontextrestored')).toBe(0);
    expect(canvas.listenerCount('webglcontextlost')).toBe(0);
  });

  it('keeps the in-frame countdown ticking while the source is paused (timed re-render ≤ 10 Hz), never while frames flow, and stops with the runtime', async () => {
    vi.useFakeTimers();
    const { source, store, rec, fe, handle } = await boot();
    const renders = () => rec.calls.filter((c) => c === 'renderer.render').length;
    fe.setNow(1000);
    source.emitFrame(1000);
    fe.setNow(1300); // paused: last frame 300 ms ago
    store.getState().setSession({ countdown: { action: 'record', endsAt: 4300, totalMs: 3000 } });
    expect(fe.rafPending).toBe(1);
    fe.flushRaf();
    expect(rec.hudExtras.at(-1)?.countdown?.secondsLeft).toBe(3);
    const before = renders();
    // No store change and no video frame: the runtime re-renders on its own so the numeral advances.
    fe.setNow(2400);
    await vi.advanceTimersByTimeAsync(100);
    expect(fe.rafPending).toBe(1);
    fe.flushRaf();
    expect(renders()).toBe(before + 1);
    expect(rec.hudExtras.at(-1)?.countdown?.secondsLeft).toBe(2);
    // Countdown over: one more render clears the numeral, then nothing further is scheduled.
    fe.setNow(4400);
    await vi.advanceTimersByTimeAsync(100);
    fe.flushRaf();
    expect(rec.hudExtras.at(-1)?.countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fe.rafPending).toBe(0);
    // While frames flow no tick is armed: the next frame shows the new numeral anyway.
    fe.setNow(5000);
    source.emitFrame(5000);
    store.getState().setSession({ countdown: { action: 'record', endsAt: 9000, totalMs: 3000 } });
    expect(fe.rafPending).toBe(0);
    fe.setNow(5016);
    source.emitFrame(5016);
    expect(rec.hudExtras.at(-1)?.countdown?.secondsLeft).toBe(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fe.rafPending).toBe(0);
    // Paused again with a live countdown → a tick is armed; stop() clears it.
    fe.setNow(7000);
    handle.requestRender();
    expect(vi.getTimerCount()).toBe(1);
    handle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('forwarding', () => {
  it('creates the tracker with the store quality rungs and forwards each change once, changed keys only', async () => {
    const { source, store, rec } = await boot();
    expect(rec.trackerOpts[0]).toMatchObject({ mirrored: true, segmentationStride: 1, inferenceMaxHeight: 720, faceStride: 1, numHands: 2, enableFace: true, enableSegmentation: true });
    source.emitFrame(16);
    expect(rec.setOptions).toEqual([]);
    store.getState().setSettings({ quality: { ...store.getState().quality, inferenceMaxHeight: 480 } });
    source.emitFrame(33);
    source.emitFrame(50);
    expect(rec.setOptions).toEqual([{ inferenceMaxHeight: 480 }]);
    store.getState().setSettings({ quality: { ...store.getState().quality, faceStride: 2, segmentationStride: 2 }, mirrored: false });
    source.emitFrame(66);
    source.emitFrame(83);
    expect(rec.setOptions).toEqual([{ inferenceMaxHeight: 480 }, { mirrored: false, segmentationStride: 2, faceStride: 2 }]);
    // renderScale / maxDpr changes do not touch the tracker.
    store.getState().setSettings({ quality: { ...store.getState().quality, renderScale: 0.7 } });
    source.emitFrame(100);
    expect(rec.setOptions).toHaveLength(2);
  });

  it('passes the store look to persona.update and the renderer, and syncs reducedMotion to the persona on change only', async () => {
    const { source, store, rec } = await boot();
    source.emitFrame(16);
    expect(rec.personaLooks.at(-1)).toEqual(store.getState().look);
    expect(rec.renderInputs.at(-1)!.look).toEqual(store.getState().look);
    expect(rec.personaReducedMotion).toEqual([false]); // first frame aligns the layer with the store
    source.emitFrame(33);
    expect(rec.personaReducedMotion).toEqual([false]);
    store.getState().setSettings({ reducedMotion: true, look: { ...store.getState().look, overlayStrength: 0.5 } });
    source.emitFrame(50);
    source.emitFrame(66);
    expect(rec.personaReducedMotion).toEqual([false, true]);
    expect(rec.personaLooks.at(-1)?.overlayStrength).toBe(0.5);
    expect(rec.renderInputs.at(-1)!.glitch).toBe(0);
  });

  it('computes the thin-slit glitch from the typed setting', async () => {
    const quadOut: InteractionOutput = {
      quad: { corners: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.7, y: 0.32 }, { x: 0.3, y: 0.32 }], opacity: 1, thickness: 0.02, area: 0.008, centroid: { x: 0.5, y: 0.31 }, visible: true, ordering: 'convex' },
      events: [],
      debug: { armed: false, togetherMs: 0, handsUsed: 2 },
    };
    const { source, store, rec } = await boot({ factoryOverrides: { createInteraction: () => ({ update: () => quadOut, reset: () => {} }) } });
    source.emitFrame(16);
    expect(rec.renderInputs.at(-1)!.glitch).toBe(0);
    store.getState().setSettings({ thinStripGlitch: true });
    source.emitFrame(33);
    expect(rec.renderInputs.at(-1)!.glitch).toBeCloseTo(0.5);
    store.getState().setSettings({ reducedMotion: true });
    source.emitFrame(50);
    expect(rec.renderInputs.at(-1)!.glitch).toBe(0);
  });
});

describe('HUD extras', () => {
  it('hudCountdown math: null when absent or expired, secondsLeft ≥ 1, progress clamped to 0..1', () => {
    expect(hudCountdown(null, 1000)).toBeNull();
    expect(hudCountdown({ action: 'record', endsAt: 1000, totalMs: 3000 }, 1000)).toBeNull();
    expect(hudCountdown({ action: 'record', endsAt: 900, totalMs: 3000 }, 1000)).toBeNull();
    expect(hudCountdown({ action: 'record', endsAt: 3500, totalMs: 3000 }, 1000)).toEqual({ action: 'record', secondsLeft: 3, progress: expect.closeTo(1 - 2500 / 3000, 9) });
    expect(hudCountdown({ action: 'snapshot', endsAt: 1200, totalMs: 3000 }, 1000)).toEqual({ action: 'snapshot', secondsLeft: 1, progress: expect.closeTo(1 - 200 / 3000, 9) });
    expect(hudCountdown({ action: 'snapshot', endsAt: 1001, totalMs: 3000 }, 1000)!.secondsLeft).toBe(1);
    // endsAt further away than totalMs (clock skew) → progress clamps at 0; zero totalMs → 1.
    expect(hudCountdown({ action: 'snapshot', endsAt: 9000, totalMs: 3000 }, 1000)!.progress).toBe(0);
    expect(hudCountdown({ action: 'snapshot', endsAt: 1500, totalMs: 0 }, 1000)!.progress).toBe(1);
  });

  it('passes countdown and dwellProgress to hud.buildModel', async () => {
    const { source, store, rec, fe } = await boot({ factoryOverrides: scriptedInteraction({ dwellProgress: 0.4 }) });
    source.emitFrame(16);
    expect(rec.hudExtras.at(-1)).toEqual({ recording: false, fps: 0, showFps: true, countdown: null, dwellProgress: 0.4 });
    store.getState().setSession({ countdown: { action: 'record', endsAt: 3500, totalMs: 3000 } });
    fe.setNow(1000);
    source.emitFrame(33);
    expect(rec.hudExtras.at(-1)?.countdown).toEqual({ action: 'record', secondsLeft: 3, progress: expect.closeTo(1 - 2500 / 3000, 9) });
    fe.setNow(4000);
    source.emitFrame(50);
    expect(rec.hudExtras.at(-1)?.countdown).toBeNull();
  });

  it('reports dwellProgress null when the interaction module does not provide it', async () => {
    const { source, rec } = await boot();
    source.emitFrame(16);
    expect(rec.hudExtras.at(-1)?.dwellProgress).toBeNull();
  });

  it('HUD off + countdown → still draws a countdown-only model (null frame/quad, no dwell ring); HUD off without countdown skips the HUD', async () => {
    const { source, store, rec, fe } = await boot({ factoryOverrides: scriptedInteraction({ dwellProgress: 0.6 }) });
    store.getState().setSettings({ hudEnabled: false });
    source.emitFrame(16);
    expect(rec.calls).not.toContain('hud.draw');
    expect(rec.renderInputs.at(-1)!.hudOverlay).toBeNull();

    store.getState().setSession({ countdown: { action: 'snapshot', endsAt: 3000, totalMs: 3000 } });
    fe.setNow(1000);
    rec.calls.length = 0;
    source.emitFrame(33);
    expect(rec.calls).toContain('hud.buildModel');
    expect(rec.calls).toContain('hud.draw');
    expect(rec.hudBuildArgs.at(-1)).toEqual({ frame: null, quad: null });
    expect(rec.hudExtras.at(-1)).toEqual({ recording: false, fps: null, showFps: false, countdown: { action: 'snapshot', secondsLeft: 2, progress: expect.closeTo(1 - 2000 / 3000, 9) }, dwellProgress: null });
    expect(rec.renderInputs.at(-1)!.hudOverlay).not.toBeNull();

    // Countdown over → HUD skipped again.
    fe.setNow(3000);
    rec.calls.length = 0;
    source.emitFrame(50);
    expect(rec.calls).not.toContain('hud.draw');
    expect(rec.renderInputs.at(-1)!.hudOverlay).toBeNull();
  });
});

describe('dwell → captureRequest', () => {
  const dwell = scriptedInteraction({ events: [{ type: 'dwell' }] });

  it('does nothing while dwellAction is off', async () => {
    const { source, store } = await boot({ factoryOverrides: dwell });
    source.emitFrame(16);
    expect(store.getState().captureRequest).toBeNull();
  });

  it('writes one snapshot request per event with incrementing ids, never while one is pending', async () => {
    const { source, store } = await boot({ factoryOverrides: dwell });
    store.getState().setSettings({ capture: { ...store.getState().capture, dwellAction: 'snapshot' } });
    source.emitFrame(16);
    expect(store.getState().captureRequest).toEqual({ action: 'snapshot', id: 1, source: 'dwell' });
    source.emitFrame(33);
    expect(store.getState().captureRequest?.id).toBe(1); // pending: not replaced
    store.getState().setSession({ captureRequest: null }); // the app consumed it
    source.emitFrame(50);
    expect(store.getState().captureRequest).toEqual({ action: 'snapshot', id: 2, source: 'dwell' });
  });

  it('requests a recording only when the recorder is idle and no countdown runs', async () => {
    const { source, store, handle } = await boot({ factoryOverrides: dwell });
    store.getState().setSettings({ capture: { ...store.getState().capture, dwellAction: 'record' } });
    await handle.recorder.start({ aspect: 'source' });
    source.emitFrame(16);
    expect(store.getState().captureRequest).toBeNull();
    await handle.recorder.stop();
    store.getState().setSession({ countdown: { action: 'record', endsAt: 99999, totalMs: 3000 } });
    source.emitFrame(33);
    expect(store.getState().captureRequest).toBeNull();
    store.getState().setSession({ countdown: null });
    source.emitFrame(50);
    expect(store.getState().captureRequest).toEqual({ action: 'record', id: 1, source: 'dwell' });
  });

  it('snapshot requests are allowed while recording', async () => {
    const { source, store, handle } = await boot({ factoryOverrides: dwell });
    store.getState().setSettings({ capture: { ...store.getState().capture, dwellAction: 'snapshot' } });
    await handle.recorder.start({ aspect: 'source' });
    source.emitFrame(16);
    expect(store.getState().captureRequest?.action).toBe('snapshot');
  });
});

describe('warm-up', () => {
  it('pre-compiles the factories warm presets once in idle time after renderer init', async () => {
    const { rec, fe } = await boot();
    expect(rec.warmed).toEqual([]);
    expect(fe.idlePending).toBe(1);
    fe.flushIdle();
    expect(rec.warmed).toEqual([rec.factories.warmPresets]);
    expect(rec.calls.filter((c) => c === 'renderer.warm')).toHaveLength(1);
  });

  it('skips the warm-up when the runtime was stopped before idle time', async () => {
    const { rec, fe, handle } = await boot();
    handle.stop();
    fe.flushIdle();
    expect(rec.warmed).toEqual([]);
  });

  it('tolerates renderers without warm()', async () => {
    const plain = (): Renderer => ({ init: async () => {}, resize: () => {}, render: () => {}, canvas: fakeCanvas(), stats: { lastFrameMs: 0, passes: 0, gpuMs: null }, dispose: () => {} });
    const { fe, handle } = await boot({ factoryOverrides: { createRenderer: plain } });
    fe.flushIdle();
    expect(handle.lastError).toBeNull();
  });
});
