import { describe, it, expect, vi } from 'vitest';
import { createLazyTracker, type TrackerModule } from '@/runtime/lazyTracker';
import type { Tracker, TrackerInfo, TrackerOptions, TrackingFrame } from '@/types';
import { flush } from './runtimeHarness';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const video = { videoWidth: 640, videoHeight: 360 } as unknown as HTMLVideoElement;

/** A controllable stand-in for the real `@/tracking` module. */
function fakeModule(opts: { failInit?: number } = {}) {
  const calls: string[] = [];
  const setOptions: Array<Partial<TrackerOptions>> = [];
  const initGate = deferred();
  let ready = false;
  let failInit = opts.failInit ?? 0;
  let createdWith: TrackerOptions | undefined;
  let progress: ((p: number) => void) | undefined;
  const info: TrackerInfo = {
    delegates: { hands: 'GPU', face: 'GPU', segmentation: 'CPU' },
    warnings: [],
    pending: Promise.resolve(),
    segmentationLabels: [],
    segmentationChannel: 0,
    lastMaskFromGpu: false,
    lastMaskFlippedY: false,
    lastMaskSize: null,
    inferenceSize: { width: 640, height: 360 },
  };
  const tracker: Tracker = {
    async init() {
      calls.push('init');
      progress?.(0.5);
      await initGate.promise;
      if (failInit > 0) {
        failInit -= 1;
        throw new Error('model 404');
      }
      progress?.(1);
      ready = true;
    },
    update(_v, t): TrackingFrame {
      calls.push('update');
      return { t, sourceWidth: 640, sourceHeight: 360, hands: [], face: { landmarks: [] } as unknown as TrackingFrame['face'], segmentation: null, timings: { handsMs: 1, faceMs: 1, segMs: 1, totalMs: 3 } };
    },
    setOptions(p) {
      setOptions.push(p);
    },
    get ready() {
      return ready;
    },
    getInfo: () => info,
    dispose() {
      calls.push('dispose');
      ready = false;
    },
  };
  const mod: TrackerModule = {
    createTracker: (o, onProgress) => {
      calls.push('create');
      createdWith = o;
      progress = onProgress;
      return tracker;
    },
  };
  return { mod, calls, setOptions, initGate, info, get createdWith() { return createdWith; } };
}

describe('createLazyTracker', () => {
  it('does not import the chunk at creation; frames are empty, ready is false and getInfo is absent before load', () => {
    const m = fakeModule();
    const load = vi.fn(() => Promise.resolve(m.mod));
    const lazy = createLazyTracker({ mirrored: true }, undefined, load);
    expect(load).not.toHaveBeenCalled();
    expect(lazy.ready).toBe(false);
    expect(lazy.loaded).toBe(false);
    expect(lazy.getInfo).toBeUndefined();
    const frame = lazy.update(video, 16);
    expect(frame).toEqual({ t: 16, sourceWidth: 640, sourceHeight: 360, hands: [], face: null, segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } });
    expect(m.calls).toEqual([]);
  });

  it('init() imports once, creates the real tracker with the original options and replays buffered setOptions as one merged call', async () => {
    const m = fakeModule();
    const load = vi.fn(() => Promise.resolve(m.mod));
    const lazy = createLazyTracker({ mirrored: true, numHands: 2 }, undefined, load);
    lazy.setOptions({ mirrored: false, segmentationStride: 2 });
    lazy.setOptions({ segmentationStride: 3, faceStride: 2 });
    const p = lazy.init();
    expect(load).toHaveBeenCalledTimes(1);
    await flush();
    expect(m.createdWith).toEqual({ mirrored: true, numHands: 2 });
    expect(m.setOptions).toEqual([{ mirrored: false, segmentationStride: 3, faceStride: 2 }]);
    expect(lazy.loaded).toBe(true);
    expect(lazy.ready).toBe(false); // loaded but the real init has not settled
    // Once loaded, options go straight through.
    lazy.setOptions({ inferenceMaxHeight: 480 });
    expect(m.setOptions.at(-1)).toEqual({ inferenceMaxHeight: 480 });
    m.initGate.resolve();
    await p;
    expect(lazy.ready).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(m.calls.filter((c) => c === 'create')).toHaveLength(1);
  });

  it('forwards progress: 0 for the import phase, then the real tracker values', async () => {
    const m = fakeModule();
    const seen: number[] = [];
    const lazy = createLazyTracker({}, (p) => seen.push(p), () => Promise.resolve(m.mod));
    const p = lazy.init();
    expect(seen).toEqual([0]);
    await flush();
    expect(seen).toEqual([0, 0.5]);
    m.initGate.resolve();
    await p;
    expect(seen).toEqual([0, 0.5, 1]);
  });

  it('passes update() and getInfo() through once loaded; init() is idempotent after success', async () => {
    const m = fakeModule();
    const lazy = createLazyTracker({}, undefined, () => Promise.resolve(m.mod));
    const p = lazy.init();
    m.initGate.resolve();
    await p;
    expect(lazy.getInfo?.()).toBe(m.info);
    const frame = lazy.update(video, 33);
    expect(frame.face).not.toBeNull();
    expect(m.calls.filter((c) => c === 'update')).toHaveLength(1);
    await lazy.init();
    expect(m.calls.filter((c) => c === 'init')).toHaveLength(1);
  });

  it('dispose() before load is safe: a later init() resolves without importing; a racing import disposes the real tracker immediately', async () => {
    const m = fakeModule();
    const load = vi.fn(() => Promise.resolve(m.mod));
    const lazy = createLazyTracker({}, undefined, load);
    lazy.setOptions({ mirrored: false });
    lazy.dispose();
    await lazy.init();
    expect(load).not.toHaveBeenCalled();
    expect(lazy.ready).toBe(false);
    expect(lazy.update(video, 1).hands).toEqual([]);

    // Import in flight when dispose() arrives.
    const m2 = fakeModule();
    const gate = deferred<TrackerModule>();
    const lazy2 = createLazyTracker({}, undefined, () => gate.promise);
    const p = lazy2.init();
    lazy2.dispose();
    gate.resolve(m2.mod);
    await p;
    expect(m2.calls).toEqual(['create', 'dispose']);
    expect(lazy2.ready).toBe(false);
  });

  it('a failed import rejects init(); the next init() retries the import', async () => {
    const m = fakeModule();
    let attempt = 0;
    const load = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('chunk load failed')) : Promise.resolve(m.mod);
    });
    const lazy = createLazyTracker({}, undefined, load);
    await expect(lazy.init()).rejects.toThrow('chunk load failed');
    expect(lazy.loaded).toBe(false);
    const p = lazy.init();
    await flush();
    m.initGate.resolve();
    await p;
    expect(load).toHaveBeenCalledTimes(2);
    expect(lazy.ready).toBe(true);
  });

  it('a failed real init rejects init(); the next init() re-runs the real init without re-importing', async () => {
    const m = fakeModule({ failInit: 1 });
    const load = vi.fn(() => Promise.resolve(m.mod));
    const lazy = createLazyTracker({}, undefined, load);
    const p1 = lazy.init();
    await flush();
    m.initGate.resolve();
    await expect(p1).rejects.toThrow('model 404');
    expect(lazy.loaded).toBe(true);
    expect(lazy.ready).toBe(false);
    await lazy.init();
    expect(load).toHaveBeenCalledTimes(1);
    expect(m.calls.filter((c) => c === 'create')).toHaveLength(1);
    expect(m.calls.filter((c) => c === 'init')).toHaveLength(2);
    expect(lazy.ready).toBe(true);
  });

  it('dispose() after load disposes the real tracker and ready drops to false', async () => {
    const m = fakeModule();
    const lazy = createLazyTracker({}, undefined, () => Promise.resolve(m.mod));
    const p = lazy.init();
    m.initGate.resolve();
    await p;
    lazy.dispose();
    expect(m.calls.at(-1)).toBe('dispose');
    expect(lazy.ready).toBe(false);
  });
});
