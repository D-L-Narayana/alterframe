/**
 * Tracker lifecycle tests with a MOCKED @mediapipe/tasks-vision.
 *
 * These prove the orchestration logic (progress reporting, GPU→CPU fallback, frame reuse,
 * segmentation stride, mirroring, sorting, timestamps, disposal). They do NOT prove that real
 * MediaPipe inference works — see docs/handoffs/W3.md for what was verified in a real browser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockCall { kind: string; delegate: string | undefined; opts: Record<string, unknown> }
const state = vi.hoisted(() => ({
  calls: [] as MockCall[],
  failGpuFor: new Set<string>(),
  closed: [] as string[],
  handTimestamps: [] as number[],
  segCalls: 0,
  handResult: { landmarks: [] as { x: number; y: number; z: number }[][], handedness: [] as { score: number; categoryName: string }[][] },
  faceResult: { faceLandmarks: [] as { x: number; y: number; z: number }[][], faceBlendshapes: [] as { categories: { categoryName: string; score: number }[] }[], facialTransformationMatrixes: [] as { rows: number; columns: number; data: number[] }[] },
  maskData: new Float32Array(4 * 2),
  maskFromGpu: false,
}));

vi.mock('@mediapipe/tasks-vision', () => {
  const make = (kind: string) => ({
    createFromOptions: vi.fn(async (_fileset: unknown, opts: { baseOptions?: { delegate?: string } }) => {
      const delegate = opts.baseOptions?.delegate;
      state.calls.push({ kind, delegate, opts: opts as Record<string, unknown> });
      if (delegate === 'GPU' && state.failGpuFor.has(kind)) throw new Error(`${kind}: GPU init failed`);
      const task = {
        close: () => { state.closed.push(kind); },
        setOptions: vi.fn(async () => undefined),
        detectForVideo: (_v: unknown, ts: number) => {
          if (kind === 'hand') { state.handTimestamps.push(ts); return state.handResult; }
          return state.faceResult;
        },
        segmentForVideo: (_v: unknown, _ts: number, cb: (r: unknown) => void) => {
          state.segCalls++;
          cb({
            confidenceMasks: [{
              width: 4, height: 2,
              hasWebGLTexture: () => state.maskFromGpu,
              hasFloat32Array: () => !state.maskFromGpu,
              getAsFloat32Array: () => state.maskData,
              close: () => undefined,
            }],
          });
        },
        getLabels: () => ['selfie'],
      };
      return task;
    }),
  });
  return {
    FilesetResolver: { forVisionTasks: vi.fn(async (base: string) => ({ wasmLoaderPath: `${base}/x.js`, wasmBinaryPath: `${base}/x.wasm` })) },
    HandLandmarker: make('hand'),
    FaceLandmarker: make('face'),
    ImageSegmenter: make('seg'),
  };
});

import { createTracker } from '../../../src/tracking';
import { HAND_LM } from '../../../src/types/tracking';

/** Fake same-origin model responses with a known byte length so progress is observable. */
function installFetch(sizes: Record<string, number>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const name = Object.keys(sizes).find((k) => url.endsWith(k));
    if (!name) return new Response(null, { status: 404 });
    const size = sizes[name]!;
    const chunk = new Uint8Array(size);
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(chunk.subarray(0, size >> 1)); c.enqueue(chunk.subarray(size >> 1)); c.close(); },
    });
    return new Response(body, { status: 200, headers: { 'content-length': String(size) } });
  }));
}

function fakeVideo(currentTime: number): HTMLVideoElement {
  // Minimal structural stand-in; the tracker only reads these fields in tests.
  return { currentTime, videoWidth: 1280, videoHeight: 720, readyState: 4 } as unknown as HTMLVideoElement;
}

const lm21 = (x: number) => Array.from({ length: 21 }, (_, i) => ({ x, y: 0.5 + i * 0.001, z: 0 }));

beforeEach(() => {
  state.calls.length = 0;
  state.closed.length = 0;
  state.handTimestamps.length = 0;
  state.failGpuFor.clear();
  state.segCalls = 0;
  state.handResult = { landmarks: [], handedness: [] };
  state.faceResult = { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
  state.maskData = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
  state.maskFromGpu = false;
  installFetch({ 'hand_landmarker.task': 1000, 'face_landmarker.task': 500, 'selfie_segmenter.tflite': 100 });
});

describe('createTracker (mocked MediaPipe)', () => {
  it('init reports monotonic progress ending at 1 and sets ready', async () => {
    const progress: number[] = [];
    const tracker = createTracker({}, (p) => progress.push(p));
    expect(tracker.ready).toBe(false);
    await tracker.init();
    expect(tracker.ready).toBe(true);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    // Models are requested from the same-origin default base.
    const urls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(expect.arrayContaining(['/models/hand_landmarker.task', '/models/face_landmarker.task', '/models/selfie_segmenter.tflite']));
  });

  it('passes the contract options to MediaPipe (2 hands, VIDEO, blendshapes, transforms, confidence masks)', async () => {
    const tracker = createTracker();
    await tracker.init();
    const hand = state.calls.find((c) => c.kind === 'hand')!;
    expect(hand.opts['numHands']).toBe(2);
    expect(hand.opts['runningMode']).toBe('VIDEO');
    const face = state.calls.find((c) => c.kind === 'face')!;
    expect(face.opts['outputFaceBlendshapes']).toBe(true);
    expect(face.opts['outputFacialTransformationMatrixes']).toBe(true);
    expect(face.opts['numFaces']).toBe(1);
    const seg = state.calls.find((c) => c.kind === 'seg')!;
    expect(seg.opts['outputConfidenceMasks']).toBe(true);
  });

  it('falls back to CPU for a task whose GPU initialisation throws, keeping GPU for the others', async () => {
    state.failGpuFor.add('face');
    const tracker = createTracker({ delegate: 'GPU' });
    await tracker.init();
    const faceCalls = state.calls.filter((c) => c.kind === 'face').map((c) => c.delegate);
    expect(faceCalls).toEqual(['GPU', 'CPU']);
    expect(state.calls.filter((c) => c.kind === 'hand').map((c) => c.delegate)).toEqual(['GPU']);
    expect(tracker.ready).toBe(true);
    // Segmentation defaults to the CPU delegate (mask must end up on the CPU anyway).
    expect(tracker.getInfo().delegates).toEqual({ hands: 'GPU', face: 'CPU', segmentation: 'CPU' });
  });

  it("segmentationDelegate: 'inherit' follows `delegate`", async () => {
    const tracker = createTracker({ delegate: 'GPU', segmentationDelegate: 'inherit' });
    await tracker.init();
    expect(tracker.getInfo().delegates.segmentation).toBe('GPU');
  });

  it('returns an empty frame before init and does not throw', () => {
    const tracker = createTracker();
    const f = tracker.update(fakeVideo(0), 100);
    expect(f.hands).toEqual([]);
    expect(f.face).toBeNull();
    expect(f.segmentation).toBeNull();
    expect(f.t).toBe(100);
  });

  it('reuses the previous frame when video.currentTime is unchanged', async () => {
    const tracker = createTracker({ enableFace: false, enableSegmentation: false });
    await tracker.init();
    const v = fakeVideo(1.0);
    const a = tracker.update(v, 10);
    const b = tracker.update(v, 20);
    expect(b).toBe(a);
    expect(state.handTimestamps).toHaveLength(1);
    v.currentTime = 1.033;
    const c = tracker.update(v, 30);
    expect(c).not.toBe(a);
    expect(state.handTimestamps).toHaveLength(2);
  });

  it('feeds MediaPipe strictly increasing timestamps even if t goes backwards', async () => {
    const tracker = createTracker({ enableFace: false, enableSegmentation: false });
    await tracker.init();
    tracker.update(fakeVideo(1), 100);
    tracker.update(fakeVideo(2), 50);
    tracker.update(fakeVideo(3), 50);
    const ts = state.handTimestamps;
    expect(ts[1]!).toBeGreaterThan(ts[0]!);
    expect(ts[2]!).toBeGreaterThan(ts[1]!);
  });

  it('mirrors x, sorts hands by palmCenter.x and assigns side by screen position', async () => {
    state.handResult = {
      landmarks: [lm21(0.2), lm21(0.7)],
      handedness: [[{ score: 0.9, categoryName: 'Left' }], [{ score: 0.8, categoryName: 'Right' }]],
    };
    const tracker = createTracker({ enableFace: false, enableSegmentation: false, mirrored: true });
    await tracker.init();
    const f = tracker.update(fakeVideo(1), 100);
    expect(f.hands).toHaveLength(2);
    // raw 0.7 → mirrored 0.3 is now screen-left
    expect(f.hands[0]!.palmCenter.x).toBeCloseTo(0.3);
    expect(f.hands[0]!.side).toBe('left');
    expect(f.hands[0]!.score).toBeCloseTo(0.8);
    expect(f.hands[1]!.palmCenter.x).toBeCloseTo(0.8);
    expect(f.hands[1]!.side).toBe('right');
    expect(f.hands[1]!.indexTip.x).toBeCloseTo(0.8);
    expect(f.sourceWidth).toBe(1280);
    expect(f.sourceHeight).toBe(720);
  });

  it('does not mirror when mirrored is false, and setOptions toggles it live', async () => {
    state.handResult = { landmarks: [lm21(0.2)], handedness: [[{ score: 0.9, categoryName: 'Left' }]] };
    const tracker = createTracker({ enableFace: false, enableSegmentation: false, mirrored: false });
    await tracker.init();
    expect(tracker.update(fakeVideo(1), 100).hands[0]!.indexTip.x).toBeCloseTo(0.2);
    tracker.setOptions({ mirrored: true });
    // New position far away → smoother slot reset, so the output equals the raw mirrored value.
    const f = tracker.update(fakeVideo(2), 1000);
    expect(f.hands[0]!.indexTip.x).toBeCloseTo(0.8);
  });

  it('smooths landmarks across frames (second frame lies between old and new positions)', async () => {
    state.handResult = { landmarks: [lm21(0.2)], handedness: [[{ score: 0.9, categoryName: 'Left' }]] };
    const tracker = createTracker({ enableFace: false, enableSegmentation: false, mirrored: false });
    await tracker.init();
    tracker.update(fakeVideo(1), 0);
    state.handResult = { landmarks: [lm21(0.4)], handedness: [[{ score: 0.9, categoryName: 'Left' }]] };
    const x = tracker.update(fakeVideo(2), 33).hands[0]!.landmarks[HAND_LM.INDEX_TIP]!.x;
    expect(x).toBeGreaterThan(0.2);
    expect(x).toBeLessThan(0.4);
  });

  it('runs segmentation every `segmentationStride` frames and keeps the last mask in between', async () => {
    const tracker = createTracker({ enableFace: false, segmentationStride: 3 });
    await tracker.init();
    const frames = [1, 2, 3, 4, 5, 6].map((i) => tracker.update(fakeVideo(i), i * 33));
    expect(state.segCalls).toBe(2); // frames 1 and 4
    expect(frames.every((f) => f.segmentation !== null)).toBe(true);
    expect(frames[1]!.segmentation).toBe(frames[0]!.segmentation);
    expect(frames[0]!.segmentation!.width).toBe(256);
    expect(frames[0]!.segmentation!.data).toHaveLength(256 * 256);
  });

  it('mask is mirrored (columns flipped) in display space', async () => {
    const tracker = createTracker({ enableFace: false, mirrored: true });
    await tracker.init();
    const seg = tracker.update(fakeVideo(1), 33).segmentation!;
    // Source row 0 = [0,1,2,3] → mirrored → leftmost output column samples source column 3.
    expect(seg.data[0]).toBe(3);
    expect(seg.data[255]).toBe(0);
  });

  it('GPU-texture masks are NOT row-flipped by default (auto) but can be with maskFlipY: always', async () => {
    state.maskFromGpu = true;
    const a = createTracker({ enableFace: false, mirrored: false });
    await a.init();
    const segA = a.update(fakeVideo(1), 33).segmentation!;
    expect(segA.data[0]).toBe(0);
    expect(a.getInfo().lastMaskFromGpu).toBe(true);
    expect(a.getInfo().lastMaskFlippedY).toBe(false);
    const b = createTracker({ enableFace: false, mirrored: false, maskFlipY: 'always' });
    await b.init();
    const segB = b.update(fakeVideo(1), 33).segmentation!;
    // First output row now comes from the LAST source row (4..7)
    expect(segB.data[0]).toBe(4);
    expect(segB.data[255 * 256]).toBe(0);
  });

  it('exposes face anchors, blendshapes and the transform', async () => {
    const face = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    face[263] = { x: 0.6, y: 0.4, z: 0 }; face[362] = { x: 0.55, y: 0.4, z: 0 }; face[386] = { x: 0.575, y: 0.39, z: 0 }; face[374] = { x: 0.575, y: 0.41, z: 0 };
    face[33] = { x: 0.4, y: 0.4, z: 0 }; face[133] = { x: 0.45, y: 0.4, z: 0 }; face[159] = { x: 0.425, y: 0.39, z: 0 }; face[145] = { x: 0.425, y: 0.41, z: 0 };
    state.faceResult = {
      faceLandmarks: [face],
      faceBlendshapes: [{ categories: [{ categoryName: 'jawOpen', score: 0.5 }, { categoryName: 'eyeBlinkLeft', score: 0.2 }] }],
      facialTransformationMatrixes: [{ rows: 4, columns: 4, data: Array.from({ length: 16 }, (_, i) => i) }],
    };
    const tracker = createTracker({ enableSegmentation: false, mirrored: false });
    await tracker.init();
    const f = tracker.update(fakeVideo(1), 33).face!;
    expect(f.landmarks).toHaveLength(478);
    expect(f.mouthOpen).toBeCloseTo(0.5);
    expect(f.blendshapes['jawOpen']).toBeCloseTo(0.5);
    expect(f.transform).toBeInstanceOf(Float32Array);
    expect(f.transform![5]).toBe(5);
    expect(f.leftEye.x).toBeLessThan(f.rightEye.x);
    // un-mirrored: subject's left eye (eyeBlinkLeft 0.2) is on screen-right
    expect(f.eyeOpenRight).toBeCloseTo(0.8);
  });

  it('records timings', async () => {
    const tracker = createTracker();
    await tracker.init();
    const f = tracker.update(fakeVideo(1), 33);
    expect(f.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(f.timings.handsMs)).toBe(true);
  });

  it('dispose closes every task and makes the tracker not ready', async () => {
    const tracker = createTracker();
    await tracker.init();
    tracker.dispose();
    expect(state.closed.sort()).toEqual(['face', 'hand', 'seg']);
    expect(tracker.ready).toBe(false);
    expect(tracker.update(fakeVideo(1), 10).hands).toEqual([]);
  });

  it('init is idempotent (second call awaits the same promise)', async () => {
    const tracker = createTracker();
    await Promise.all([tracker.init(), tracker.init()]);
    expect(state.calls.filter((c) => c.kind === 'hand')).toHaveLength(1);
  });

  it('reports a readable error when a model is missing (404)', async () => {
    installFetch({ 'hand_landmarker.task': 1000, 'face_landmarker.task': 500 }); // no segmenter model
    const tracker = createTracker();
    await expect(tracker.init()).rejects.toThrow(/selfie_segmenter\.tflite.*404/);
    expect(tracker.ready).toBe(false);
  });

  it('setOptions can switch the delegate; the affected tasks are re-created without re-downloading', async () => {
    const tracker = createTracker({ enableFace: false, enableSegmentation: false });
    await tracker.init();
    const fetchCalls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    tracker.setOptions({ delegate: 'CPU' });
    await tracker.getInfo().pending;
    expect(state.calls.filter((c) => c.kind === 'hand').map((c) => c.delegate)).toEqual(['GPU', 'CPU']);
    expect(state.closed).toEqual(['hand']);
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(fetchCalls);
    expect(tracker.getInfo().delegates.hands).toBe('CPU');
  });
});
