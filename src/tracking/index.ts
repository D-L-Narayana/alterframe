/**
 * W3 — Tracking. `createTracker()` wraps MediaPipe Tasks Vision (HandLandmarker, FaceLandmarker,
 * ImageSegmenter) behind the `Tracker` contract (src/types/tracking.ts).
 *
 * Output convention (binding for every consumer): normalized coordinates of the INTRINSIC VIDEO
 * FRAME, [0,1], origin top-left, mirrored exactly once here when `mirrored` is true (landmarks
 * x → 1 - x, mask columns reversed). Nothing here knows about the CSS canvas or cover-fit.
 */
import { FaceLandmarker, FilesetResolver, HandLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';
import type {
  FaceLandmarkerResult,
  HandLandmarkerResult,
  ImageSegmenterResult,
  NormalizedLandmark,
} from '@mediapipe/tasks-vision';

/** `WasmFileset` is not exported by the package typings; derive it from the resolver. */
type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
import type { Vec2, Vec3 } from '../types/geometry';
import type {
  FaceTrack,
  HandTrack,
  SegmentationResult,
  Tracker,
  TrackerInfo,
  TrackerOptions,
  TrackingFrame,
  TrackingTimings,
} from '../types/tracking';
import { assignSides, deriveFace, deriveHand, matchHands, mirrorLandmarks, sortHands } from './derive';
import { createDefaultInferenceCanvas, inferenceTarget } from './inference';
import type { InferenceCanvas, InferenceCanvasFactory } from './inference';
import { MODEL_SPECS, ModelCache, ProgressAggregator, joinUrl } from './loader';
import { MASK_SIZE, maskOrientationFlipY, resampleMask } from './mask';
import type { MaskFlipPolicy } from './mask';
import { DEFAULT_SMOOTHING, LandmarkSetSmoother } from './smoothing';
import type { OneEuroParams } from './smoothing';
import { TELEMETRY_BLOCKED_WARNING, installTelemetryGuard } from './telemetryGuard';

export { DEFAULT_SMOOTHING, LandmarkSetSmoother, OneEuroFilter } from './smoothing';
export type { OneEuroParams } from './smoothing';
export { assignSides, deriveFace, deriveHand, matchHands, mirrorLandmarks, sortHands } from './derive';
export { MASK_SIZE, maskOrientationFlipY, resampleMask } from './mask';
export type { MaskFlipPolicy } from './mask';
export { MODEL_SPECS } from './loader';
export { createDefaultInferenceCanvas, evenSize, inferenceTarget } from './inference';
export type { InferenceCanvas, InferenceCanvasFactory } from './inference';
export { BLOCKED_TELEMETRY_HOSTS, TELEMETRY_BLOCKED_WARNING, installTelemetryGuard, isBlockedTelemetryUrl } from './telemetryGuard';
export type { TelemetryGuard } from './telemetryGuard';

export type Delegate = 'GPU' | 'CPU';

/** Contract options plus W3-specific knobs (all optional; W2 may pass plain `TrackerOptions`). */
export interface AlterFrameTrackerOptions extends TrackerOptions {
  /**
   * Delegate for the segmenter only. Default 'CPU': the mask has to end up in a CPU
   * `Float32Array` anyway (W4 cannot sample a texture from MediaPipe's own GL context), the model
   * is tiny (256×256), and the CPU path avoids a GPU→CPU `readPixels` sync plus the bottom-left
   * origin question. 'inherit' follows `delegate`.
   */
  segmentationDelegate?: Delegate | 'inherit';
  /**
   * Row-flip policy for masks read back from a GPU texture. 'auto' never flips: measured with
   * tasks-vision 1.0.1 in Chromium (harness `verify.mjs`, synthetic person in a known quadrant),
   * the CPU path and the GPU-texture read-back return the same top-left-origin rows, i.e.
   * MediaPipe already compensates for the GL bottom-left origin. 'always' / 'never' override
   * for a device that disagrees.
   */
  maskFlipY?: MaskFlipPolicy;
  /** Reset per-hand smoothing after the hand has been missing this long (ms). Default 500. */
  smoothingResetMs?: number;
  /**
   * Factory for the internal downscale canvas used when the source is taller than
   * `inferenceMaxHeight`. Default: `OffscreenCanvas` → `document.createElement('canvas')`; returning
   * null disables the downscale (the source is fed at native size). Injectable for Node tests.
   */
  createCanvas?: InferenceCanvasFactory;
}

/** Diagnostics shape is the shared contract type (src/types/tracking.ts). */
export type { TrackerInfo } from '../types/tracking';

export interface AlterFrameTracker extends Tracker {
  getInfo(): TrackerInfo;
}

type Resolved = Required<Omit<AlterFrameTrackerOptions, 'smoothing'>> & { smoothing: OneEuroParams };

/**
 * Asset folders relative to the app's base URL, so the bundle works at the domain root (Vercel)
 * and under a sub-path (Vite `base: './'`, private previews). Outside a document (unit tests)
 * falls back to root-absolute paths.
 */
function defaultAssetUrl(folder: 'models' | 'wasm'): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  if (typeof document === 'undefined') return `/${folder}`;
  return new URL(`${base}${folder}`, document.baseURI).href;
}

const DEFAULTS: Resolved = {
  modelBaseUrl: defaultAssetUrl('models'),
  wasmBaseUrl: defaultAssetUrl('wasm'),
  delegate: 'GPU',
  numHands: 2,
  enableFace: true,
  enableSegmentation: true,
  segmentationStride: 1,
  faceStride: 1,
  inferenceMaxHeight: 720,
  mirrored: true,
  smoothing: DEFAULT_SMOOTHING,
  segmentationDelegate: 'CPU',
  maskFlipY: 'auto',
  smoothingResetMs: 500,
  createCanvas: createDefaultInferenceCanvas,
};

function resolve(base: Resolved, partial: Partial<AlterFrameTrackerOptions>): Resolved {
  const out: Resolved = { ...base };
  // Only copy keys that are actually defined (exactOptionalPropertyTypes-friendly).
  for (const k of Object.keys(partial) as (keyof AlterFrameTrackerOptions)[]) {
    const v = partial[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

const emptyTimings = (): TrackingTimings => ({ handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 });

function emptyFrame(t: number, w: number, h: number): TrackingFrame {
  return { t, sourceWidth: w, sourceHeight: h, hands: [], face: null, segmentation: null, timings: emptyTimings() };
}

function sourceSize(src: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): { w: number; h: number } {
  if ('videoWidth' in src) return { w: src.videoWidth, h: src.videoHeight };
  return { w: src.width, h: src.height };
}

/** Per-hand smoothing slot. */
interface HandSlot { smoother: LandmarkSetSmoother; palm: Vec2 | null; lastSeen: number }

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type FrameInput = HTMLVideoElement | HTMLCanvasElement | ImageBitmap;

/** The one context method the downscale needs; satisfied by both canvas kinds (and by test fakes). */
interface Drawable2D { drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void }

/** 2D context of either canvas kind (the union's overloaded `getContext` is not callable as one). */
function get2d(canvas: InferenceCanvas): Drawable2D | null {
  const c = canvas as unknown as { getContext(id: '2d', options?: { alpha?: boolean }): Drawable2D | null };
  try {
    return c.getContext('2d', { alpha: false }) ?? null;
  } catch {
    return null;
  }
}

/** True when WebGL2 is definitely unavailable (so a GPU delegate cannot work). */
function webgl2Unavailable(): boolean {
  if (typeof document === 'undefined') return false; // unknown environment → let MediaPipe decide
  try {
    const c = document.createElement('canvas');
    return c.getContext('webgl2') === null;
  } catch {
    return true;
  }
}

export function createTracker(opts: AlterFrameTrackerOptions = {}, onProgress?: (progress01: number) => void): AlterFrameTracker {
  let options = resolve(DEFAULTS, opts);
  const cache = new ModelCache();

  let fileset: WasmFileset | null = null;
  let hands: HandLandmarker | null = null;
  let face: FaceLandmarker | null = null;
  let seg: ImageSegmenter | null = null;

  const info: TrackerInfo = {
    delegates: { hands: null, face: null, segmentation: null },
    warnings: [],
    pending: Promise.resolve(),
    segmentationLabels: [],
    segmentationChannel: 0,
    lastMaskFromGpu: false,
    lastMaskFlippedY: false,
    lastMaskSize: null,
    inferenceSize: null,
  };

  let ready = false;
  let disposed = false;
  let initPromise: Promise<void> | null = null;

  // --- per-frame state -------------------------------------------------------------------
  const handSlots: HandSlot[] = [];
  const faceSmoother = new LandmarkSetSmoother(options.smoothing, options.smoothingResetMs);
  const maskData = new Float32Array(MASK_SIZE * MASK_SIZE);
  let segmentation: SegmentationResult | null = null;
  let lastFrame: TrackingFrame | null = null;
  let lastCurrentTime = -1;
  let lastTs = -1;
  let frameCounter = 0;
  // Inference input: the source itself, or a downscaled copy when taller than `inferenceMaxHeight`.
  let inferenceCanvas: InferenceCanvas | null = null;
  let inferenceCtx: Drawable2D | null = null;
  let downscaleUnavailable = false;
  // Face stride: the FaceTrack from the last face run, handed out by identity until the next run.
  let lastFaceTrack: FaceTrack | null = null;
  let lastFaceRunTs = -Infinity;

  const segDelegate = (): Delegate => (options.segmentationDelegate === 'inherit' ? options.delegate : options.segmentationDelegate);

  function warn(msg: string): void {
    info.warnings.push(msg);
    if (info.warnings.length > 20) info.warnings.shift();
  }

  // Privacy: the tracking library's bundled usage logger would POST to odml.pa.googleapis.com
  // 60 s after each task is created and on close(). Installed (idempotently) before any task
  // exists; a blocked attempt is refused locally and reported here. See telemetryGuard.ts.
  const telemetry = installTelemetryGuard();
  const offTelemetry = telemetry.onBlocked(() => warn(TELEMETRY_BLOCKED_WARNING));

  // --- task construction with GPU→CPU fallback -----------------------------------------
  async function createWithFallback<T>(
    label: 'hands' | 'face' | 'segmentation',
    wanted: Delegate,
    factory: (delegate: Delegate) => Promise<T>,
  ): Promise<T> {
    let delegate: Delegate = wanted;
    if (delegate === 'GPU' && webgl2Unavailable()) {
      warn(`[tracking] ${label}: WebGL2 unavailable, using CPU delegate`);
      delegate = 'CPU';
    }
    try {
      const task = await factory(delegate);
      info.delegates[label] = delegate;
      return task;
    } catch (err) {
      if (delegate === 'CPU') throw err;
      warn(`[tracking] ${label}: GPU delegate failed (${(err as Error).message}); falling back to CPU`);
      const task = await factory('CPU');
      info.delegates[label] = 'CPU';
      return task;
    }
  }

  async function buildHands(fs: WasmFileset, buffer: Uint8Array): Promise<HandLandmarker> {
    return createWithFallback('hands', options.delegate, (delegate) =>
      HandLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetBuffer: buffer, delegate },
        runningMode: 'VIDEO',
        numHands: options.numHands,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }));
  }

  async function buildFace(fs: WasmFileset, buffer: Uint8Array): Promise<FaceLandmarker> {
    return createWithFallback('face', options.delegate, (delegate) =>
      FaceLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetBuffer: buffer, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      }));
  }

  async function buildSeg(fs: WasmFileset, buffer: Uint8Array): Promise<ImageSegmenter> {
    const task = await createWithFallback('segmentation', segDelegate(), (delegate) =>
      ImageSegmenter.createFromOptions(fs, {
        baseOptions: { modelAssetBuffer: buffer, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }));
    // selfie_segmenter has a single label ("selfie") → one confidence channel = person
    // probability. Multi-class models list 'person'; pick it if present, else channel 0.
    try { info.segmentationLabels = task.getLabels(); } catch { info.segmentationLabels = []; }
    const idx = info.segmentationLabels.findIndex((l) => /person|selfie|foreground/i.test(l));
    info.segmentationChannel = idx >= 0 ? idx : 0;
    return task;
  }

  function spec(id: 'hands' | 'face' | 'segmentation') {
    return MODEL_SPECS.find((s) => s.id === id)!;
  }

  /**
   * One init attempt. Re-entrant by design: after a rejected attempt the wasm fileset is kept and
   * the ModelCache keeps every model that did download (failed entries are dropped), so a retry
   * fetches only the missing pieces; progress restarts at 0 and is monotonic within the attempt.
   */
  async function doInit(): Promise<void> {
    const enabled = MODEL_SPECS.filter((s) =>
      (s.id === 'hands') || (s.id === 'face' && options.enableFace) || (s.id === 'segmentation' && options.enableSegmentation));
    const progress = new ProgressAggregator(onProgress, enabled, enabled.length);

    if (!fileset) fileset = await FilesetResolver.forVisionTasks(options.wasmBaseUrl);
    const fs = fileset;
    progress.wasmReady();

    const buffers = await Promise.all(enabled.map((s) =>
      cache.load(joinUrl(options.modelBaseUrl, s.file), s.expectedBytes, (l, t) => progress.bytes(s.id, l, t))));
    if (disposed) return;
    const buf = (id: ModelSpecId): Uint8Array => buffers[enabled.findIndex((s) => s.id === id)]!;

    // Sequential construction: each GPU task compiles shaders; doing them one by one keeps the
    // main thread responsive enough for the progress bar to repaint.
    hands = await buildHands(fs, buf('hands'));
    progress.initStep();
    if (options.enableFace) { face = await buildFace(fs, buf('face')); progress.initStep(); }
    if (options.enableSegmentation) { seg = await buildSeg(fs, buf('segmentation')); progress.initStep(); }
    if (disposed) { closeAll(); return; }
    progress.done();
    ready = true;
  }

  function closeAll(): void {
    hands?.close(); face?.close(); seg?.close();
    hands = null; face = null; seg = null;
    info.delegates = { hands: null, face: null, segmentation: null };
  }

  // --- reconfiguration (delegate / numHands / enable toggles) ---------------------------
  async function reconfigure(prev: Resolved): Promise<void> {
    if (!ready || !fileset || disposed) return;
    const fs = fileset;
    const delegateChanged = prev.delegate !== options.delegate;
    if (delegateChanged || prev.numHands !== options.numHands) {
      const old = hands;
      hands = await buildHands(fs, await cache.load(joinUrl(options.modelBaseUrl, spec('hands').file), spec('hands').expectedBytes));
      old?.close();
    }
    if (delegateChanged || prev.enableFace !== options.enableFace) {
      const old = face; face = null; info.delegates.face = null; old?.close();
      if (options.enableFace) face = await buildFace(fs, await cache.load(joinUrl(options.modelBaseUrl, spec('face').file), spec('face').expectedBytes));
    }
    const segDelegateChanged = (prev.segmentationDelegate === 'inherit' ? prev.delegate : prev.segmentationDelegate) !== segDelegate();
    if (segDelegateChanged || prev.enableSegmentation !== options.enableSegmentation) {
      const old = seg; seg = null; info.delegates.segmentation = null; old?.close();
      segmentation = null;
      if (options.enableSegmentation) seg = await buildSeg(fs, await cache.load(joinUrl(options.modelBaseUrl, spec('segmentation').file), spec('segmentation').expectedBytes));
    }
    if (disposed) closeAll();
  }

  // --- per-frame processing ---------------------------------------------------------------
  function toVec3(lms: NormalizedLandmark[], out: Vec3[]): Vec3[] {
    out.length = lms.length;
    for (let i = 0; i < lms.length; i++) {
      const l = lms[i]!;
      const o = out[i];
      if (o) { o.x = l.x; o.y = l.y; o.z = l.z; } else out[i] = { x: l.x, y: l.y, z: l.z };
    }
    return out;
  }

  const copyPts = (pts: readonly Vec3[]): Vec3[] => pts.map((p) => ({ x: p.x, y: p.y, z: p.z }));

  function processHands(res: HandLandmarkerResult, ts: number, aspect: number): HandTrack[] {
    const n = res.landmarks.length;
    // Raw (mirrored) palm centres for slot matching.
    const rawSets: Vec3[][] = [];
    const palms: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const pts = toVec3(res.landmarks[i]!, []);
      if (options.mirrored) mirrorLandmarks(pts, pts); // in place: each point reads itself before writing
      rawSets.push(pts);
      const w = pts[0]!, a = pts[5]!, b = pts[9]!, c = pts[13]!, d = pts[17]!;
      palms.push({ x: (w.x + a.x + b.x + c.x + d.x) / 5, y: (w.y + a.y + b.y + c.y + d.y) / 5 });
    }
    const slotOf = matchHands(handSlots.map((s) => (ts - s.lastSeen <= options.smoothingResetMs ? s.palm : null)), palms);
    const out: HandTrack[] = [];
    for (let i = 0; i < n; i++) {
      const si = slotOf[i]!;
      while (handSlots.length <= si) handSlots.push({ smoother: new LandmarkSetSmoother(options.smoothing, options.smoothingResetMs), palm: null, lastSeen: -Infinity });
      const slot = handSlots[si]!;
      const smoothed = copyPts(slot.smoother.apply(rawSets[i]!, ts));
      slot.palm = palms[i]!;
      slot.lastSeen = ts;
      const score = res.handedness[i]?.[0]?.score ?? res.handednesses?.[i]?.[0]?.score ?? 1;
      out.push(deriveHand(smoothed, score, 'left', aspect));
    }
    return assignSides(sortHands(out));
  }

  function processFace(res: FaceLandmarkerResult, ts: number, aspect: number): FaceTrack | null {
    const lms = res.faceLandmarks[0];
    if (!lms) return null;
    const pts = toVec3(lms, []);
    if (options.mirrored) mirrorLandmarks(pts, pts);
    const smoothed = copyPts(faceSmoother.apply(pts, ts));
    const blend: Record<string, number> = {};
    const cats = res.faceBlendshapes[0]?.categories;
    if (cats) for (const c of cats) blend[c.categoryName] = c.score;
    const m = res.facialTransformationMatrixes[0];
    // MediaPipe's MatrixData is column-major by default; passed through untouched and NOT
    // mirrored (it lives in camera space). Consumers should prefer the display-space landmarks.
    const transform = m ? Float32Array.from(m.data) : null;
    return deriveFace(smoothed, blend, transform, aspect);
  }

  function onSegmentation(result: ImageSegmenterResult): void {
    const mask = result.confidenceMasks?.[info.segmentationChannel] ?? result.confidenceMasks?.[0];
    if (!mask) return;
    // Evaluate BEFORE getAsFloat32Array(): on the GPU path that call performs the readPixels
    // readback whose rows are bottom-up; on the CPU path the array is already top-left.
    const fromGpu = mask.hasWebGLTexture() && !mask.hasFloat32Array();
    const flipY = maskOrientationFlipY(options.maskFlipY, fromGpu);
    const data = mask.getAsFloat32Array();
    resampleMask(data, mask.width, mask.height, maskData, MASK_SIZE, MASK_SIZE, { mirror: options.mirrored, flipY });
    info.lastMaskFromGpu = fromGpu;
    info.lastMaskFlippedY = flipY;
    info.lastMaskSize = { width: mask.width, height: mask.height };
    // The mask is owned by the task and freed when the callback returns; a new result object
    // tells consumers (by identity) that the data changed.
    segmentation = { width: MASK_SIZE, height: MASK_SIZE, data: maskData, texture: null };
  }

  function setInferenceSize(width: number, height: number): void {
    const s = info.inferenceSize;
    if (s && s.width === width && s.height === height) return;
    info.inferenceSize = { width, height };
  }

  /**
   * The frame handed to the models. A source not taller than `inferenceMaxHeight` goes through
   * untouched (no copy). A taller one is drawn ONCE into the internal even-sized canvas (allocated
   * lazily, resized in place when the target changes after a live setOptions, shared by all three
   * tasks). No coordinate remapping is needed downstream: MediaPipe reports landmarks normalized
   * to [0,1] of whatever image it was given, and the mask is resampled to MASK_SIZE regardless.
   */
  function inferenceInput(video: FrameInput, w: number, h: number): FrameInput | InferenceCanvas {
    const target = inferenceTarget(w, h, options.inferenceMaxHeight);
    if (target && !downscaleUnavailable) {
      if (!inferenceCanvas) {
        const canvas = options.createCanvas(target.width, target.height);
        const ctx = canvas ? get2d(canvas) : null;
        if (canvas && ctx) {
          inferenceCanvas = canvas;
          inferenceCtx = ctx;
        } else {
          downscaleUnavailable = true;
          warn(`[tracking] inference downscale unavailable (no 2D canvas here); feeding frames at native ${w}×${h}`);
        }
      }
      if (inferenceCanvas && inferenceCtx) {
        if (inferenceCanvas.width !== target.width || inferenceCanvas.height !== target.height) {
          inferenceCanvas.width = target.width;
          inferenceCanvas.height = target.height;
        }
        inferenceCtx.drawImage(video, 0, 0, target.width, target.height);
        setInferenceSize(target.width, target.height);
        return inferenceCanvas;
      }
    }
    setInferenceSize(w, h);
    return video;
  }

  function update(video: HTMLVideoElement | HTMLCanvasElement | ImageBitmap, t: number): TrackingFrame {
    const { w, h } = sourceSize(video);
    if (!ready || disposed) return emptyFrame(t, w, h);
    const isVideo = 'currentTime' in video;
    if (isVideo) {
      const v = video as HTMLVideoElement;
      if (v.readyState < 2 || w === 0 || h === 0) return lastFrame ?? emptyFrame(t, w, h);
      // Same decoded frame as last time (display rate > video rate): return the cached result.
      if (lastFrame && v.currentTime === lastCurrentTime) return lastFrame;
      lastCurrentTime = v.currentTime;
    }
    // MediaPipe keys packets by INTEGER microseconds (ms × 1000, truncated) and requires them to be
    // strictly increasing per task. Float milliseconds are not enough: a legitimate re-run of a frame
    // 1 µs later (runtime `requestRender()`), or any step < 1 ms, can truncate to the same microsecond
    // packet → "Packet timestamp mismatch … free_memory" → the task throws and would be rebuilt on
    // CPU. Integer milliseconds spaced ≥ 1 ms survive the ×1000 exactly, also when `t` goes
    // backwards (clock-domain change). `lastFrame.t` keeps the caller's own `t`.
    const ts = Math.max(Math.floor(t), lastTs + 1);
    lastTs = ts;
    frameCounter++;
    const aspect = h > 0 ? w / h : 16 / 9;
    const timings = emptyTimings();
    const t0 = now();

    // One resample per analysed frame (never per task): the same input feeds hands, face and mask.
    const input = inferenceInput(video, w, h);

    let handTracks: HandTrack[] = [];
    if (hands) {
      try { handTracks = processHands(hands.detectForVideo(input, ts), ts, aspect); }
      catch (err) { handleTaskError('hands', err); }
    }
    const t1 = now(); timings.handsMs = t1 - t0;

    // Face stride: run the landmarker every N analysed frames (the first one included) and hand out
    // the SAME FaceTrack object in between — until smoothingResetMs pass without a run that saw a face.
    const faceStride = Math.max(1, Math.round(options.faceStride) || 1);
    const faceDue = ((frameCounter - 1) % faceStride) === 0;
    let faceTrack: FaceTrack | null = null;
    if (face && faceDue) {
      try { faceTrack = processFace(face.detectForVideo(input, ts), ts, aspect); }
      catch (err) { handleTaskError('face', err); }
      lastFaceTrack = faceTrack;
      lastFaceRunTs = ts;
    } else if (face && lastFaceTrack && ts - lastFaceRunTs <= options.smoothingResetMs) {
      faceTrack = lastFaceTrack;
    } else {
      lastFaceTrack = null;
    }
    const t2 = now(); timings.faceMs = faceDue ? t2 - t1 : 0;

    if (seg && ((frameCounter - 1) % Math.max(1, options.segmentationStride)) === 0) { // runs on the first frame
      try { seg.segmentForVideo(input, ts, onSegmentation); }
      catch (err) { handleTaskError('segmentation', err); }
    }
    const t3 = now(); timings.segMs = t3 - t2;
    timings.totalMs = t3 - t0;

    lastFrame = { t, sourceWidth: w, sourceHeight: h, hands: handTracks, face: faceTrack, segmentation, timings };
    return lastFrame;
  }

  /**
   * Runtime failure of a task (e.g. GPU shader error on first inference). First failure on GPU
   * → rebuild that task on CPU; failure on CPU → disable the task and keep going.
   */
  const recovering = new Set<string>();
  function handleTaskError(label: 'hands' | 'face' | 'segmentation', err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    if (recovering.has(label)) return;
    recovering.add(label);
    const current = info.delegates[label];
    if (current === 'GPU' && fileset) {
      warn(`[tracking] ${label}: GPU inference failed (${msg}); rebuilding on CPU`);
      const fs = fileset;
      const s = spec(label);
      const job = (async () => {
        const buffer = await cache.load(joinUrl(options.modelBaseUrl, s.file), s.expectedBytes);
        const prev = options;
        if (label === 'segmentation') {
          options = { ...options, segmentationDelegate: 'CPU' };
          seg?.close(); seg = null; segmentation = null;
          seg = await buildSeg(fs, buffer);
        } else {
          // Switching hands/face to CPU switches `delegate` (shared by both) and rebuilds both.
          options = { ...options, delegate: 'CPU' };
          await reconfigure(prev);
        }
        recovering.delete(label);
      })().catch((e: unknown) => {
        warn(`[tracking] ${label}: CPU rebuild failed (${(e as Error)?.message ?? String(e)}); task disabled`);
        disable(label);
      });
      info.pending = info.pending.then(() => job);
    } else {
      warn(`[tracking] ${label}: inference failed (${msg}); task disabled`);
      disable(label);
    }
  }

  function disable(label: 'hands' | 'face' | 'segmentation'): void {
    if (label === 'hands') { hands?.close(); hands = null; }
    if (label === 'face') { face?.close(); face = null; }
    if (label === 'segmentation') { seg?.close(); seg = null; segmentation = null; }
    info.delegates[label] = null;
  }

  const tracker: AlterFrameTracker = {
    get ready() { return ready; },
    init() {
      if (!initPromise) {
        initPromise = doInit().catch((err: unknown) => {
          // Leave nothing half-built behind: the next init() rebuilds every task from the cache.
          closeAll();
          initPromise = null;
          ready = false;
          throw err;
        });
      }
      return initPromise;
    },
    update,
    setOptions(partial) {
      const prev = options;
      options = resolve(options, partial);
      if (partial.smoothing !== undefined) {
        faceSmoother.setParams(options.smoothing);
        for (const s of handSlots) s.smoother.setParams(options.smoothing);
      }
      if (prev.mirrored !== options.mirrored) {
        // Everything downstream jumps to the other side; forget smoothing history so landmarks
        // don't slide across the screen, and drop the stale mask orientation and the reused face.
        faceSmoother.reset();
        for (const s of handSlots) { s.smoother.reset(); s.palm = null; s.lastSeen = -Infinity; }
        segmentation = null;
        lastFrame = null;
        lastFaceTrack = null;
      }
      // `inferenceMaxHeight` / `faceStride` are read per frame: the next analysed frame picks them
      // up (the downscale canvas is resized in place). A new canvas factory gets a fresh attempt.
      if (prev.createCanvas !== options.createCanvas) downscaleUnavailable = false;
      const structural = prev.delegate !== options.delegate || prev.numHands !== options.numHands
        || prev.enableFace !== options.enableFace || prev.enableSegmentation !== options.enableSegmentation
        || prev.segmentationDelegate !== options.segmentationDelegate;
      if (structural && ready) {
        info.pending = info.pending.then(() => reconfigure(prev)).catch((err: unknown) => {
          warn(`[tracking] reconfigure failed: ${(err as Error)?.message ?? String(err)}`);
        });
      }
    },
    dispose() {
      disposed = true;
      ready = false;
      closeAll(); // may trigger the logger's close-time flush → one last warning, then detach
      offTelemetry();
      segmentation = null;
      lastFrame = null;
      lastFaceTrack = null;
      inferenceCanvas = null;
      inferenceCtx = null;
      info.inferenceSize = null;
      cache.clear();
    },
    getInfo() {
      return info;
    },
  };
  return tracker;
}

type ModelSpecId = 'hands' | 'face' | 'segmentation';
