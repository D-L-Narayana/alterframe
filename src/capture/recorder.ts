import type { CaptureAspect, Recorder, RecorderOptions, RecorderState } from '@/types/capture';
import { computeCrop, type CropPlan } from './crop';
import { DEFAULT_MIME_CANDIDATES, pickMime } from './mime';
import { snapshot, type SnapshotDeps } from './snapshot';

/* ------------------------------------------------------------------------------------------------
 * Minimal structural types so the recorder can be driven by fakes in Node (no DOM) and by the
 * real `HTMLCanvasElement` / `MediaRecorder` in the browser. Only members we actually use.
 * ---------------------------------------------------------------------------------------------- */

export interface Canvas2dLike {
  drawImage(
    image: CanvasImageSource | CanvasLike,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

export interface MediaStreamLike {
  getTracks(): Array<{ stop(): void }>;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d', opts?: CanvasRenderingContext2DSettings): Canvas2dLike | null;
  captureStream?(fps?: number): MediaStreamLike;
}

export interface MediaRecorderLike {
  readonly state: 'inactive' | 'recording' | 'paused';
  readonly mimeType: string;
  start(timesliceMs?: number): void;
  stop(): void;
  requestData?(): void;
  addEventListener(type: 'dataavailable', cb: (ev: { data?: Blob }) => void): void;
  addEventListener(type: 'stop', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: { error?: unknown }) => void): void;
}

export interface MediaRecorderCtor {
  new (stream: MediaStreamLike, options: MediaRecorderOptions): MediaRecorderLike;
  isTypeSupported(mime: string): boolean;
}

/** Injection points (all optional). Defaults are the browser globals. */
export interface RecorderDeps extends SnapshotDeps {
  /** `undefined` means "browser has no MediaRecorder" → `start()` rejects readably. */
  MediaRecorder?: MediaRecorderCtor | undefined;
  now?: () => number;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
  /** Called on every state transition (W2 mirrors this into the store). */
  onStateChange?: (state: RecorderState, elapsedMs: number) => void;
  /** MediaRecorder timeslice; chunks arrive periodically so memory is bounded per chunk. Default 1000. */
  timesliceMs?: number;
  /** Safety net if the `stop` event never fires (seen on some Chromium builds when a track ends). Default 5000. */
  stopTimeoutMs?: number;
}

export interface RecordingResult {
  blob: Blob;
  mime: string;
  durationMs: number;
}

function defaultMediaRecorder(): MediaRecorderCtor | undefined {
  const g = globalThis as { MediaRecorder?: unknown };
  return typeof g.MediaRecorder === 'function' ? (g.MediaRecorder as unknown as MediaRecorderCtor) : undefined;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** `video/webm;codecs=vp9` → `video/webm` (Blob types should be bare containers). */
function containerOf(mime: string): string {
  return mime.split(';')[0]?.trim() ?? mime;
}

/**
 * Canvas recorder. Records the composited stage canvas via `captureStream` + `MediaRecorder`.
 * For non-`source` aspects the frames are centre-cropped into an intermediate canvas on every
 * animation frame (see `computeCrop`) and that canvas is the recorded stream.
 */
export function createRecorder(getCanvas: () => HTMLCanvasElement, deps: RecorderDeps = {}): Recorder {
  const MR = 'MediaRecorder' in deps ? deps.MediaRecorder : defaultMediaRecorder();
  const now = deps.now ?? defaultNow;
  const requestFrame =
    deps.requestFrame ?? ((cb: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0));
  const cancelFrame = deps.cancelFrame ?? ((id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : void 0));
  const timesliceMs = deps.timesliceMs ?? 1000;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5000;

  let state: RecorderState = 'idle';
  let startedAt = 0;
  let frozenDuration = 0;
  let mime = '';
  let chunks: Blob[] = [];
  let rec: MediaRecorderLike | null = null;
  let stream: MediaStreamLike | null = null;
  let cropCanvas: CanvasLike | null = null;
  let rafId: number | null = null;
  let pendingStop: Promise<RecordingResult> | null = null;
  let lastError: Error | null = null;

  function setState(next: RecorderState) {
    state = next;
    deps.onStateChange?.(next, elapsed());
  }

  function elapsed(): number {
    if (state === 'recording') return now() - startedAt;
    if (state === 'finalizing') return frozenDuration;
    return 0;
  }

  /** Stop tracks, cancel the crop loop, release the crop canvas, forget the recorder. */
  function cleanup() {
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    if (stream) {
      try {
        for (const t of stream.getTracks()) t.stop();
      } catch {
        /* a dead stream is fine */
      }
      stream = null;
    }
    if (cropCanvas) {
      // Zero-size canvas releases its backing store immediately.
      cropCanvas.width = 0;
      cropCanvas.height = 0;
      cropCanvas = null;
    }
    rec = null;
    chunks = [];
  }

  function startCropLoop(source: CanvasLike, target: CanvasLike, ctx: Canvas2dLike, aspect: CaptureAspect) {
    const draw = () => {
      // Recompute each frame: the stage canvas may resize mid-recording (window resize / dpr change).
      let plan: CropPlan;
      try {
        plan = computeCrop(source.width, source.height, aspect);
      } catch {
        return; // transiently empty source → skip this frame
      }
      ctx.drawImage(source, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, target.width, target.height);
    };
    draw(); // first frame must not be blank
    const loop = () => {
      draw();
      rafId = requestFrame(loop);
    };
    rafId = requestFrame(loop);
  }

  async function start(opts: RecorderOptions): Promise<void> {
    if (state === 'recording') throw new Error('Recorder is already recording.');
    if (state === 'finalizing') throw new Error('Recorder is still finalizing the previous recording.');
    if (!MR) throw new Error('MediaRecorder is not supported in this browser; recording is unavailable.');

    const candidates = opts.mimeCandidates ?? DEFAULT_MIME_CANDIDATES;
    const picked = pickMime(candidates, (m) => MR.isTypeSupported(m));
    if (!picked) {
      throw new Error(`No supported video format for recording (tried ${candidates.join(', ')}).`);
    }

    const source = getCanvas() as unknown as CanvasLike;
    if (!source) throw new Error('No stage canvas to record.');
    const fps = opts.fps ?? 30;

    let recordedCanvas: CanvasLike = source;
    try {
      if (opts.aspect !== 'source') {
        const plan = computeCrop(source.width, source.height, opts.aspect); // throws on empty
        const target = (deps.createCanvas ?? defaultCreateCanvas)(plan.dw, plan.dh);
        const ctx = target.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('Could not create a 2D context for the crop canvas.');
        cropCanvas = target;
        recordedCanvas = target;
        startCropLoop(source, target, ctx, opts.aspect);
      } else {
        computeCrop(source.width, source.height, 'source'); // validates non-empty
      }

      if (typeof recordedCanvas.captureStream !== 'function') {
        throw new Error('canvas.captureStream is not supported in this browser; recording is unavailable.');
      }
      stream = recordedCanvas.captureStream(fps);

      try {
        rec = new MR(stream, { mimeType: picked, videoBitsPerSecond: opts.videoBitsPerSecond ?? 12_000_000 });
      } catch (e) {
        throw new Error(`Could not start recording: ${errorMessage(e)}`, { cause: e });
      }
      mime = picked;
      chunks = [];
      lastError = null;
      const current = rec;
      current.addEventListener('dataavailable', (ev) => {
        if (rec === current && ev.data && ev.data.size > 0) chunks.push(ev.data);
      });
      current.addEventListener('error', (ev) => {
        if (rec !== current) return;
        lastError = new Error(`Recording failed: ${errorMessage(ev.error ?? 'unknown MediaRecorder error')}`);
        if (state === 'recording') {
          // Not finalizing: nobody is awaiting; tear down and report on the next stop().
          cleanup();
          setState('idle');
        }
        // If finalizing, the pending stop() promise observes `lastError` via the stop handler.
      });
      try {
        current.start(timesliceMs);
      } catch (e) {
        throw new Error(`Could not start recording: ${errorMessage(e)}`, { cause: e });
      }
    } catch (e) {
      cleanup();
      throw e;
    }
    startedAt = now();
    setState('recording');
  }

  function stop(): Promise<RecordingResult> {
    if (state === 'finalizing' && pendingStop) return pendingStop;
    if (state !== 'recording' || !rec) {
      if (lastError) {
        const err = lastError;
        lastError = null;
        return Promise.reject(err);
      }
      return Promise.reject(new Error('Not recording.'));
    }
    frozenDuration = now() - startedAt;
    setState('finalizing');
    const current = rec;
    const durationMs = frozenDuration;

    pendingStop = new Promise<RecordingResult>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const collected = chunks;
        const err = lastError;
        lastError = null;
        cleanup();
        pendingStop = null;
        setState('idle');
        if (err) {
          reject(err);
          return;
        }
        const blob = new Blob(collected, { type: containerOf(mime) });
        if (blob.size === 0) {
          reject(new Error('Recording produced no data (the canvas may have been hidden or the stream ended).'));
          return;
        }
        resolve({ blob, mime, durationMs });
      };
      const timer = setTimeout(finish, stopTimeoutMs);
      current.addEventListener('stop', finish);
      try {
        if (current.state !== 'inactive') current.stop();
        else queueMicrotask(finish);
      } catch (e) {
        lastError = new Error(`Recording failed: ${errorMessage(e)}`);
        finish();
      }
    });
    return pendingStop;
  }

  return {
    get state() {
      return state;
    },
    get elapsedMs() {
      return elapsed();
    },
    start,
    stop,
    snapshot: (aspect) => snapshot(getCanvas(), aspect, deps),
  };
}

function defaultCreateCanvas(w: number, h: number): CanvasLike {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c as unknown as CanvasLike;
}
