/**
 * Media environment — the handful of browser globals the sources touch,
 * injectable so the state machines can be unit-tested in Node (no jsdom in
 * the toolchain) and so the harness can swap a fake camera in.
 *
 * Production callers never pass this; `defaultMediaEnv()` reads real globals
 * lazily (at call time, never at module load, so importing this file in Node
 * is safe).
 */

/** Subset of HTMLVideoElement the sources rely on (keeps fakes small). */
export type VideoLike = HTMLVideoElement;

export interface MediaEnv {
  /** `navigator.mediaDevices` or undefined when the browser lacks it (http, old Safari). */
  mediaDevices: MediaDevices | undefined;
  /** Creates a detached <video>; sources configure muted/playsInline/autoplay themselves. */
  createVideo(): VideoLike;
  /** `URL.createObjectURL` / `revokeObjectURL` (file source). */
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Visibility API hooks; undefined when no `document` (tests, workers). */
  documentRef: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | undefined;
  /** Frame scheduling fallback when `requestVideoFrameCallback` is unavailable. */
  requestAnimationFrame(cb: (t: number) => void): number;
  cancelAnimationFrame(id: number): void;
  now(): number;
}

export function defaultMediaEnv(): MediaEnv {
  const g = globalThis as typeof globalThis & { document?: Document; navigator?: Navigator };
  return {
    mediaDevices: g.navigator?.mediaDevices,
    createVideo: () => {
      if (!g.document) throw new Error('No document: cannot create a <video> element in this environment');
      return g.document.createElement('video');
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    documentRef: g.document,
    requestAnimationFrame: (cb) =>
      typeof g.requestAnimationFrame === 'function'
        ? g.requestAnimationFrame(cb)
        : (setTimeout(() => cb(performance.now()), 16) as unknown as number),
    cancelAnimationFrame: (id) =>
      typeof g.cancelAnimationFrame === 'function' ? g.cancelAnimationFrame(id) : clearTimeout(id),
    now: () => performance.now(),
  };
}

/** Fills missing fields of a partial env with the real defaults. */
export function resolveMediaEnv(partial?: Partial<MediaEnv>): MediaEnv {
  if (!partial) return defaultMediaEnv();
  const base = defaultMediaEnv();
  return { ...base, ...partial };
}
