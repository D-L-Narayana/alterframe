import type { MediaEnv, VideoLike } from './env';

export type FrameCallback = (t: number, meta: { presentedFrames: number }) => void;

/** Minimal shape of the WICG `requestVideoFrameCallback` API (not in lib.dom for every TS version). */
interface VideoWithRvfc {
  requestVideoFrameCallback?: (cb: (now: number, meta: { presentedFrames?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

/**
 * Fan-out "new video frame" notifier shared by camera and file sources.
 *
 * Strategy:
 *  1. `requestVideoFrameCallback` when the element supports it (Chromium, Safari):
 *     fires exactly once per presented frame → no duplicate work, no missed frames.
 *  2. Otherwise `requestAnimationFrame` polling, emitting only when
 *     `video.currentTime` changed (so a paused/stalled video does not spin the pipeline,
 *     while a seek on a paused clip still presents its new frame once).
 *
 * The clock is armed only while ≥1 listener is registered AND `running` is true,
 * so `stop()` cancels every pending callback (contract: stop cancels callbacks).
 */
export function createFrameClock(video: VideoLike, env: MediaEnv) {
  const listeners = new Set<FrameCallback>();
  let running = false;
  let rvfcHandle: number | null = null;
  let rafHandle: number | null = null;
  let lastTime = -1;
  let presented = 0;
  const rvfc = video as unknown as VideoWithRvfc;
  const hasRvfc = typeof rvfc.requestVideoFrameCallback === 'function';

  function emit(t: number, presentedFrames: number): void {
    for (const cb of listeners) cb(t, { presentedFrames });
  }

  function scheduleRvfc(): void {
    if (rvfcHandle !== null || !rvfc.requestVideoFrameCallback) return;
    rvfcHandle = rvfc.requestVideoFrameCallback((now, meta) => {
      rvfcHandle = null;
      if (!running) return;
      presented = meta.presentedFrames ?? presented + 1;
      emit(now, presented);
      if (running && listeners.size > 0) scheduleRvfc();
    });
  }

  function scheduleRaf(): void {
    if (rafHandle !== null) return;
    rafHandle = env.requestAnimationFrame((now) => {
      rafHandle = null;
      if (!running) return;
      // Only a change in currentTime means a new frame is available — also after a seek while paused.
      const ct = video.currentTime;
      if (ct !== lastTime && video.readyState >= 2 /* HAVE_CURRENT_DATA */) {
        lastTime = ct;
        presented += 1;
        emit(now, presented);
      }
      if (running && listeners.size > 0) scheduleRaf();
    });
  }

  function arm(): void {
    if (!running || listeners.size === 0) return;
    if (hasRvfc) scheduleRvfc();
    else scheduleRaf();
  }

  function disarm(): void {
    if (rvfcHandle !== null && rvfc.cancelVideoFrameCallback) rvfc.cancelVideoFrameCallback(rvfcHandle);
    rvfcHandle = null;
    if (rafHandle !== null) env.cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }

  return {
    /** Register a listener; returns unsubscribe. */
    subscribe(cb: FrameCallback): () => void {
      listeners.add(cb);
      arm();
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) disarm();
      };
    },
    start(): void {
      if (running) return;
      running = true;
      lastTime = -1;
      arm();
    },
    stop(): void {
      running = false;
      disarm();
    },
    /** True when the element exposes requestVideoFrameCallback (exposed for the harness/stats). */
    get usesVideoFrameCallback(): boolean {
      return hasRvfc;
    },
    get listenerCount(): number {
      return listeners.size;
    },
  };
}

export type FrameClock = ReturnType<typeof createFrameClock>;
