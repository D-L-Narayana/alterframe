import type { CameraOptions, FrameSource } from '@/types';
import { resolveMediaEnv, type MediaEnv } from './env';
import { createFrameClock } from './frameClock';
import { MediaSourceError, classifyGetUserMediaError } from './errors';
import { createStatusMachine, prepareVideoElement, safePlay, type ObservableFrameSource } from './sourceBase';

export interface CameraSource extends ObservableFrameSource {
  readonly kind: 'camera';
  /** Active MediaStream while `ready`, else null. */
  readonly stream: MediaStream | null;
  /** Active device id (from track settings) when known. */
  readonly deviceId: string | null;
  listDevices(): Promise<MediaDeviceInfo[]>;
}

const DEFAULTS = { width: 1280, height: 720, frameRate: 30 } as const;
/** How long to wait for `loadedmetadata` after the stream is attached before giving up. */
const METADATA_TIMEOUT_MS = 8000;

/**
 * Builds getUserMedia constraints. `deviceId` wins over `facingMode` (a device
 * already implies a facing). `exact` deviceId so the picker is honoured; the
 * caller retries relaxed when that device vanished (see `start`).
 */
export function buildCameraConstraints(opts: CameraOptions, relaxed = false): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: opts.width ?? DEFAULTS.width },
    height: { ideal: opts.height ?? DEFAULTS.height },
    frameRate: { ideal: opts.frameRate ?? DEFAULTS.frameRate },
  };
  if (opts.deviceId && !relaxed) video.deviceId = { exact: opts.deviceId };
  else if (opts.facingMode) video.facingMode = relaxed ? opts.facingMode : { ideal: opts.facingMode };
  return { video, audio: false };
}

function waitForMetadata(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= 1 /* HAVE_METADATA */ && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new MediaSourceError('error', 'The camera stream produced no frames. Try another camera or a video file.'));
    }, timeoutMs);
    const onMeta = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new MediaSourceError('error', 'The camera stream could not be decoded.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
  });
}

/**
 * Webcam frame source.
 * Status: idle → requesting → ready | denied | unavailable | error; `stop()` → idle.
 * `start()` resolves on `ready`, rejects with `MediaSourceError` otherwise (status is
 * set either way, so callers may `catch` OR inspect `source.status`).
 */
export function createCameraSource(opts: CameraOptions = {}, envPartial?: Partial<MediaEnv>): CameraSource {
  const env: MediaEnv = resolveMediaEnv(envPartial);
  const status = createStatusMachine();
  const video = env.createVideo();
  prepareVideoElement(video);
  const clock = createFrameClock(video, env);

  let stream: MediaStream | null = null;
  let width = 0;
  let height = 0;
  let facing: 'user' | 'environment' = opts.facingMode ?? 'user';
  let deviceId: string | null = opts.deviceId ?? null;
  let devices: MediaDeviceInfo[] | null = null;
  let startPromise: Promise<void> | null = null;
  let pausedByVisibility = false;
  const trackCleanups: Array<() => void> = [];

  const onVisibility = () => {
    const doc = env.documentRef;
    if (!doc || status.status !== 'ready') return;
    if (doc.visibilityState === 'hidden') {
      // Pausing the element stops decode work; tracks stay live so resume is instant.
      pausedByVisibility = true;
      video.pause();
    } else if (pausedByVisibility) {
      pausedByVisibility = false;
      void safePlay(video);
    }
  };

  function fail(err: unknown): MediaSourceError {
    const e =
      err instanceof MediaSourceError
        ? err
        : (() => {
            const c = classifyGetUserMediaError(err);
            return new MediaSourceError(c.status, c.message, err);
          })();
    releaseStream();
    status.set(e.status, e.message);
    return e;
  }

  function releaseStream(): void {
    for (const c of trackCleanups.splice(0)) c();
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    if ('srcObject' in video) video.srcObject = null;
  }

  async function acquire(): Promise<MediaStream> {
    const md = env.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
      throw new MediaSourceError(
        'unavailable',
        'This browser cannot access cameras here (needs HTTPS or localhost). You can open a video file instead.',
      );
    }
    try {
      return await md.getUserMedia(buildCameraConstraints(opts));
    } catch (err) {
      // A remembered deviceId that no longer exists → retry with any camera of the same facing.
      const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
      if (opts.deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'ConstraintNotSatisfiedError')) {
        return md.getUserMedia(buildCameraConstraints(opts, true));
      }
      throw err;
    }
  }

  async function doStart(): Promise<void> {
    status.set('requesting');
    try {
      const s = await acquire();
      if (status.status !== 'requesting') {
        // stop() raced with the permission prompt: release what we just got.
        for (const t of s.getTracks()) t.stop();
        return;
      }
      stream = s;
      const [track] = s.getVideoTracks();
      if (!track) throw new MediaSourceError('unavailable', 'The camera stream has no video track.');
      const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
      if (settings.facingMode === 'environment' || settings.facingMode === 'user') facing = settings.facingMode;
      if (settings.deviceId) deviceId = settings.deviceId;

      const onEnded = () => {
        // Device unplugged / OS revoked the stream.
        releaseStream();
        status.set('unavailable', 'The camera was disconnected. Reconnect it and retry, or open a video file.');
      };
      track.addEventListener('ended', onEnded);
      trackCleanups.push(() => track.removeEventListener('ended', onEnded));

      video.srcObject = s;
      await waitForMetadata(video, METADATA_TIMEOUT_MS);
      await safePlay(video);
      width = video.videoWidth || settings.width || 0;
      height = video.videoHeight || settings.height || 0;

      // Labels are only populated after permission → enumerate now and cache.
      void refreshDevices();
      env.documentRef?.addEventListener('visibilitychange', onVisibility);
      clock.start();
      status.set('ready');
    } catch (err) {
      throw fail(err);
    } finally {
      startPromise = null;
    }
  }

  async function refreshDevices(): Promise<MediaDeviceInfo[]> {
    const md = env.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return (devices = []);
    try {
      devices = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      devices = devices ?? [];
    }
    return devices;
  }

  const source: CameraSource = {
    kind: 'camera',
    video,
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
    get facingMode() {
      return facing;
    },
    get stream() {
      return stream;
    },
    get deviceId() {
      return deviceId;
    },
    start() {
      if (status.status === 'ready') return Promise.resolve();
      if (!startPromise) startPromise = doStart();
      return startPromise;
    },
    stop() {
      clock.stop();
      env.documentRef?.removeEventListener('visibilitychange', onVisibility);
      pausedByVisibility = false;
      releaseStream();
      video.pause();
      width = 0;
      height = 0;
      status.set('idle');
    },
    onFrame: (cb) => clock.subscribe(cb),
    onStatus: (cb) => status.onStatus(cb),
    listDevices: () => (devices ? Promise.resolve(devices) : refreshDevices()),
  };
  return source;
}

/** Type guard used by UI code that wants camera-only features (device picker). */
export function isCameraSource(s: FrameSource): s is CameraSource {
  return s.kind === 'camera' && typeof (s as Partial<CameraSource>).listDevices === 'function';
}
