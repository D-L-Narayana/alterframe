/**
 * Lazy tracker — keeps MediaPipe out of the entry chunk.
 *
 * `@/tracking` (and with it `@mediapipe/tasks-vision`) is imported dynamically the first time
 * `init()` runs, so the app shell paints before the tracking code is even fetched. Until the chunk
 * has arrived the wrapper behaves like a tracker that is not ready yet: `update()` returns an
 * empty frame, `setOptions()` is buffered and replayed onto the real tracker, `ready` is false and
 * `getInfo` is absent. `init()` rejects when the import or the real init fails and can be called
 * again (the real tracker's `init()` is re-entrant), which is what `retryTracker()` relies on.
 */
import type { CreateTracker, Tracker, TrackerOptions, TrackingFrame } from '@/types';

/** Shape of the module `load()` resolves to (`import('@/tracking')` satisfies it). */
export interface TrackerModule { createTracker: CreateTracker }
export type TrackerLoader = () => Promise<TrackerModule>;

export interface LazyTracker extends Tracker {
  /** True once the chunk is imported and the real tracker exists (it may still be loading models). */
  readonly loaded: boolean;
}

const defaultLoader: TrackerLoader = () => import('@/tracking');

function emptyFrame(video: HTMLVideoElement | HTMLCanvasElement | ImageBitmap, t: number): TrackingFrame {
  const w = 'videoWidth' in video ? video.videoWidth : video.width;
  const h = 'videoHeight' in video ? video.videoHeight : video.height;
  return { t, sourceWidth: w, sourceHeight: h, hands: [], face: null, segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } };
}

export function createLazyTracker(opts: TrackerOptions = {}, onProgress?: (progress01: number) => void, load: TrackerLoader = defaultLoader): LazyTracker {
  let real: Tracker | null = null;
  let loading: Promise<Tracker> | null = null;
  let initPromise: Promise<void> | null = null;
  let buffered: Partial<TrackerOptions> | null = null;
  let disposed = false;

  function ensureLoaded(): Promise<Tracker> {
    if (real) return Promise.resolve(real);
    if (!loading) {
      loading = load().then(
        (mod) => {
          const t = mod.createTracker(opts, onProgress);
          if (buffered) {
            t.setOptions(buffered);
            buffered = null;
          }
          real = t;
          const info = t.getInfo;
          if (typeof info === 'function') lazy.getInfo = () => info.call(t);
          // dispose() raced with the import: never keep models alive after teardown.
          if (disposed) t.dispose();
          return t;
        },
        (err: unknown) => {
          loading = null; // a later init() retries the import
          throw err;
        },
      );
    }
    return loading;
  }

  const lazy: LazyTracker = {
    init() {
      if (disposed) return Promise.resolve();
      if (!initPromise) {
        initPromise = (async () => {
          onProgress?.(0); // import phase: nothing downloaded yet
          const t = await ensureLoaded();
          if (disposed) return;
          await t.init();
        })().catch((err: unknown) => {
          initPromise = null; // a later init() re-runs the real (re-entrant) init
          throw err;
        });
      }
      return initPromise;
    },
    update(video, t) {
      return real ? real.update(video, t) : emptyFrame(video, t);
    },
    setOptions(partial) {
      if (real) real.setOptions(partial);
      else buffered = { ...(buffered ?? {}), ...partial };
    },
    get ready() {
      return real?.ready ?? false;
    },
    get loaded() {
      return real !== null;
    },
    dispose() {
      disposed = true;
      buffered = null;
      real?.dispose();
    },
  };
  return lazy;
}
