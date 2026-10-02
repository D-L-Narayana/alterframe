import type { PerfSample } from '@/types/capture';

export interface PerfMonitorOptions {
  now?: () => number;
  /** EMA time constant in ms (fps smoothing). Default 500. */
  emaTauMs?: number;
  /** Ring buffer length in ms. Default 5000. */
  bufferMs?: number;
  /** A gap longer than this (tab hidden, modal) re-seeds the EMA instead of registering as ~0 fps. Default 2000. */
  pauseThresholdMs?: number;
}

export interface PerfMonitor {
  /** Call once per rendered frame with the measured phase timings. */
  sample(s: Omit<PerfSample, 't' | 'fps'>): void;
  /** Smoothed frames per second (0 until two frames have been seen). */
  fps(): number;
  /** Samples with `t >= now - ms`, oldest first. */
  recent(ms: number): PerfSample[];
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Frame-rate monitor. fps is an exponential moving average of the instantaneous rate
 * (1000 / dt between consecutive `sample()` calls) with a time-based alpha
 * `1 - exp(-dt / tau)`, so the smoothing is the same whether frames arrive at 30 or 120 Hz.
 */
export function createPerfMonitor(opts: PerfMonitorOptions = {}): PerfMonitor {
  const now = opts.now ?? defaultNow;
  const tau = opts.emaTauMs ?? 500;
  const bufferMs = opts.bufferMs ?? 5000;
  const pauseThreshold = opts.pauseThresholdMs ?? 2000;

  const buffer: PerfSample[] = [];
  let lastT: number | null = null;
  let ema: number | null = null;

  function sample(s: Omit<PerfSample, 't' | 'fps'>): void {
    const t = now();
    if (lastT !== null) {
      const dt = t - lastT;
      if (dt > pauseThreshold) {
        ema = null; // long pause: forget the rate, next frame re-seeds
      } else if (dt > 0) {
        const inst = 1000 / dt;
        if (ema === null) {
          ema = inst;
        } else {
          const alpha = 1 - Math.exp(-dt / tau);
          ema += alpha * (inst - ema);
        }
      }
      // dt === 0: duplicate call in the same tick — rate unchanged.
    }
    lastT = t;
    buffer.push({ t, fps: ema ?? 0, frameMs: s.frameMs, trackingMs: s.trackingMs, renderMs: s.renderMs });
    // Prune from the front; samples arrive in time order so a single scan suffices.
    const cutoff = t - bufferMs;
    let drop = 0;
    while (drop < buffer.length && buffer[drop]!.t < cutoff) drop++;
    if (drop > 0) buffer.splice(0, drop);
  }

  return {
    sample,
    fps: () => ema ?? 0,
    recent(ms: number): PerfSample[] {
      const cutoff = now() - ms;
      let i = 0;
      while (i < buffer.length && buffer[i]!.t < cutoff) i++;
      return buffer.slice(i);
    },
  };
}
