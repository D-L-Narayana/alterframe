import type { FrameSource } from '@/types';
import { resolveMediaEnv, type MediaEnv } from './env';
import { createFrameClock } from './frameClock';
import { MediaSourceError } from './errors';
import { createStatusMachine, prepareVideoElement, safePlay, type ObservableFrameSource } from './sourceBase';

export interface FileSource extends ObservableFrameSource {
  readonly kind: 'file';
  /** Resolved media URL (object URL for File inputs; revoked on stop). */
  readonly url: string;
  /** Explicit play — call from a user gesture if autoplay was blocked. */
  play(): Promise<boolean>;
  pause(): void;
  readonly paused: boolean;
}

/** Media element error codes → readable text (MediaError constants). */
export function describeMediaError(code: number | undefined): string {
  switch (code) {
    case 1:
      return 'Loading the video was aborted.';
    case 2:
      return 'A network error interrupted the video.';
    case 3:
      return 'The video could not be decoded.';
    case 4:
      return 'This video format is not supported by your browser.';
    default:
      return 'The video could not be loaded.';
  }
}

/**
 * Video-file frame source (fallback when the camera is denied/unavailable, and
 * the e2e fixture path). Loops, muted, inline. Status becomes `ready` on
 * `loadedmetadata`; playback is attempted immediately — if the browser blocks
 * autoplay the source is still `ready` and `play()` can be called from a gesture.
 *
 * Accepts a `File`/`Blob` (object URL, revoked on `stop()`) or a same-origin URL
 * string (never fetched by us; the element streams it). File sources report
 * `facingMode: 'user'` so the default mirror applies like a selfie camera.
 */
export function createFileSource(file: File | Blob | string, envPartial?: Partial<MediaEnv>): FileSource {
  const env: MediaEnv = resolveMediaEnv(envPartial);
  const status = createStatusMachine();
  const video = env.createVideo();
  prepareVideoElement(video);
  video.loop = true;
  const clock = createFrameClock(video, env);

  const isBlob = typeof file !== 'string';
  const url = isBlob ? env.createObjectURL(file) : file;
  let revoked = false;
  let width = 0;
  let height = 0;
  let startPromise: Promise<void> | null = null;
  let pausedByVisibility = false;

  const onVisibility = () => {
    const doc = env.documentRef;
    if (!doc || status.status !== 'ready') return;
    if (doc.visibilityState === 'hidden') {
      if (!video.paused) {
        pausedByVisibility = true;
        video.pause();
      }
    } else if (pausedByVisibility) {
      pausedByVisibility = false;
      void safePlay(video);
    }
  };

  const onEnded = () => {
    // `loop` normally prevents this; some browsers fire it anyway at the wrap. Keep going.
    if (status.status === 'ready') void safePlay(video);
  };

  function revoke(): void {
    if (isBlob && !revoked) {
      revoked = true;
      env.revokeObjectURL(url);
    }
  }

  function doStart(): Promise<void> {
    status.set('requesting');
    return new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        cleanup();
        width = video.videoWidth;
        height = video.videoHeight;
        if (!(width > 0 && height > 0)) {
          const e = new MediaSourceError('error', 'The file has no video track (audio-only?).');
          status.set('error', e.message);
          reject(e);
          return;
        }
        env.documentRef?.addEventListener('visibilitychange', onVisibility);
        video.addEventListener('ended', onEnded);
        clock.start();
        status.set('ready');
        // Autoplay: the file was picked via a user gesture, so this normally succeeds.
        void safePlay(video);
        resolve();
      };
      const onErr = () => {
        cleanup();
        const code = video.error?.code;
        const e = new MediaSourceError('error', describeMediaError(code), video.error);
        status.set('error', e.message);
        reject(e);
      };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('error', onErr);
        startPromise = null;
      };
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('error', onErr);
      video.src = url;
      if (typeof video.load === 'function') video.load();
    });
  }

  const source: FileSource = {
    kind: 'file',
    video,
    url,
    facingMode: 'user',
    get status() {
      return status.status;
    },
    get error() {
      return status.error;
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get paused() {
      return video.paused;
    },
    start() {
      if (status.status === 'ready') return Promise.resolve();
      if (revoked) return Promise.reject(new MediaSourceError('error', 'This file source was stopped; create a new one.'));
      if (!startPromise) startPromise = doStart();
      return startPromise;
    },
    stop() {
      clock.stop();
      env.documentRef?.removeEventListener('visibilitychange', onVisibility);
      video.removeEventListener('ended', onEnded);
      pausedByVisibility = false;
      video.pause();
      // Detach before revoking so the element does not try to re-fetch the dead URL.
      video.removeAttribute?.('src');
      video.src = '';
      if (typeof video.load === 'function') video.load();
      revoke();
      width = 0;
      height = 0;
      status.set('idle');
    },
    onFrame: (cb) => clock.subscribe(cb),
    onStatus: (cb) => status.onStatus(cb),
    play: () => safePlay(video),
    pause: () => video.pause(),
  };
  return source;
}

export function isFileSource(s: FrameSource): s is FileSource {
  return s.kind === 'file' && typeof (s as Partial<FileSource>).play === 'function';
}
