import type { FileTransport, FrameSource, TransportState } from '@/types';
import { resolveMediaEnv, type MediaEnv } from './env';
import { createFrameClock } from './frameClock';
import { MediaSourceError } from './errors';
import { createStatusMachine, prepareVideoElement, safePlay, type ObservableFrameSource } from './sourceBase';

export type TransportListener = (state: TransportState) => void;

/** A source with playback controls that also announces transport changes (file sources). */
export interface TransportEventSource extends FrameSource {
  readonly transport: FileTransport;
  /**
   * Fires with a fresh `TransportState` after the element's play / pause / seeked / ratechange /
   * durationchange / ended events and after `transport.setLoop`. Returns unsubscribe.
   */
  onTransport(cb: TransportListener): () => void;
}

export interface FileSource extends ObservableFrameSource {
  readonly kind: 'file';
  /** Resolved media URL (object URL for File inputs; revoked on stop). */
  readonly url: string;
  /** Explicit play — call from a user gesture if autoplay was blocked. */
  play(): Promise<boolean>;
  pause(): void;
  readonly paused: boolean;
  readonly transport: FileTransport;
  onTransport(cb: TransportListener): () => void;
}

/** Element events after which the transport snapshot may have changed. */
const TRANSPORT_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'durationchange', 'ended'] as const;

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
 * `transport` exposes play / pause / seek / loop for the UI; `onTransport` lets the runtime mirror
 * the state into the store without polling. Accepts a `File`/`Blob` (object URL, revoked on
 * `stop()`) or a same-origin URL string (never fetched by us; the element streams it). File sources
 * report `facingMode: 'user'` so the default mirror applies like a selfie camera.
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
        notifyTransport();
      }
    } else if (pausedByVisibility) {
      pausedByVisibility = false;
      void safePlay(video);
      notifyTransport();
    }
  };

  const onEnded = () => {
    // `loop` normally prevents this; some browsers fire it anyway at the wrap. Keep going — but
    // only while looping: with loop off the clip must end paused (the user controls playback).
    if (status.status === 'ready' && video.loop) {
      void safePlay(video);
      notifyTransport();
    }
  };

  // ------------------------------------------------------------- transport
  // Latency contract: a command publishes the element's state in the SAME task. Per the HTML spec
  // `paused` flips synchronously inside play()/pause() and `currentTime` reports the new official
  // position right after the assignment, so the UI mirror never waits for the element's later
  // `play` / `pause` / `seeked` event task — on a busy main thread that task queues behind the next
  // inference frame (seconds on slow devices). The element events still re-notify with the settled
  // values (e.g. autoplay blocked → `paused` flips back → `pause` event).
  const transportListeners = new Set<TransportListener>();
  let stopped = false;
  let transportEventsAttached = false;
  function transportSnapshot(): TransportState {
    return { paused: video.paused, currentTime: video.currentTime, duration: video.duration, loop: video.loop };
  }
  function notifyTransport(): void {
    if (stopped || transportListeners.size === 0) return;
    const s = transportSnapshot();
    for (const cb of [...transportListeners]) cb(s);
  }
  function attachTransportEvents(): void {
    if (transportEventsAttached) return;
    transportEventsAttached = true;
    for (const ev of TRANSPORT_EVENTS) video.addEventListener(ev, notifyTransport);
  }
  function detachTransportEvents(): void {
    if (!transportEventsAttached) return;
    transportEventsAttached = false;
    for (const ev of TRANSPORT_EVENTS) video.removeEventListener(ev, notifyTransport);
  }
  attachTransportEvents();

  const transport: FileTransport = {
    async play() {
      if (stopped) return false;
      const pending = safePlay(video); // video.play() runs synchronously inside: `paused` is already false here
      notifyTransport();
      const ok = await pending;
      notifyTransport(); // settled: playback started, or blocked and the element flipped back
      return ok;
    },
    pause() {
      if (stopped) return;
      video.pause();
      notifyTransport();
    },
    seek(seconds) {
      if (stopped) return;
      const d = video.duration;
      const max = Number.isFinite(d) && d > 0 ? d : Infinity; // duration is NaN until metadata
      video.currentTime = Number.isFinite(seconds) ? Math.min(max, Math.max(0, seconds)) : 0;
      notifyTransport(); // official position is already the new one; `seeked` re-notifies once the frame is decoded
    },
    setLoop(loop) {
      if (stopped || video.loop === loop) return;
      video.loop = loop; // no element event for this one → notify ourselves
      notifyTransport();
    },
    get paused() {
      return video.paused;
    },
    get currentTime() {
      return video.currentTime;
    },
    get duration() {
      return video.duration;
    },
    get loop() {
      return video.loop;
    },
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
    transport,
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
      if (!startPromise) {
        stopped = false; // a URL source may be restarted after stop()
        attachTransportEvents();
        startPromise = doStart();
      }
      return startPromise;
    },
    stop() {
      clock.stop();
      env.documentRef?.removeEventListener('visibilitychange', onVisibility);
      video.removeEventListener('ended', onEnded);
      detachTransportEvents();
      transportListeners.clear();
      stopped = true;
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
    onTransport(cb) {
      transportListeners.add(cb);
      return () => {
        transportListeners.delete(cb);
      };
    },
    // One implementation: the convenience methods ARE the transport commands (same synchronous mirror).
    play: () => transport.play(),
    pause: () => transport.pause(),
  };
  return source;
}

export function isFileSource(s: FrameSource): s is FileSource {
  return s.kind === 'file' && typeof (s as Partial<FileSource>).play === 'function';
}

/** True when the source has a transport AND announces its changes (`onTransport`). */
export function hasTransportEvents(s: FrameSource): s is TransportEventSource {
  return !!s.transport && typeof (s as Partial<TransportEventSource>).onTransport === 'function';
}
