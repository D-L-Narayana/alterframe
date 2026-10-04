/**
 * Inference resolution (`inferenceMaxHeight`), face stride and re-entrant `init()` — with a MOCKED
 * @mediapipe/tasks-vision (same pattern as tracker.test.ts).
 *
 * These prove the orchestration only: which object is handed to the tasks, how often the downscale
 * canvas is redrawn, FaceTrack identity between face runs, progress/fileset reuse on a retry. They
 * do NOT prove that real MediaPipe inference works on a downscaled canvas — the dev harness in
 * src/tracking/__harness__ (verify.mjs) runs the real tasks in Chromium for that.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** Every frame handed to a task, in call order. */
  inputs: [] as { kind: string; src: unknown }[],
  faceCalls: 0,
  handResult: { landmarks: [] as { x: number; y: number; z: number }[][], handedness: [] as { score: number; categoryName: string }[][] },
  faceResult: { faceLandmarks: [] as { x: number; y: number; z: number }[][], faceBlendshapes: [] as { categories: { categoryName: string; score: number }[] }[], facialTransformationMatrixes: [] as { rows: number; columns: number; data: number[] }[] },
}));

vi.mock('@mediapipe/tasks-vision', () => {
  const make = (kind: string) => ({
    createFromOptions: vi.fn(async () => ({
      close: () => undefined,
      detectForVideo: (src: unknown, _ts: number) => {
        state.inputs.push({ kind, src });
        if (kind === 'face') { state.faceCalls++; return state.faceResult; }
        return state.handResult;
      },
      segmentForVideo: (src: unknown, _ts: number, cb: (r: unknown) => void) => {
        state.inputs.push({ kind, src });
        cb({
          confidenceMasks: [{
            width: 4, height: 2,
            hasWebGLTexture: () => false,
            hasFloat32Array: () => true,
            getAsFloat32Array: () => new Float32Array(8),
            close: () => undefined,
          }],
        });
      },
      getLabels: () => ['selfie'],
    })),
  });
  return {
    FilesetResolver: { forVisionTasks: vi.fn(async (base: string) => ({ wasmLoaderPath: `${base}/x.js`, wasmBinaryPath: `${base}/x.wasm` })) },
    HandLandmarker: make('hand'),
    FaceLandmarker: make('face'),
    ImageSegmenter: make('seg'),
  };
});

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { createTracker, evenSize, inferenceTarget } from '../../../src/tracking';

interface FetchStub { sizes: Record<string, number>; calls: string[] }

/** Same-origin model responses with a known length; `sizes` is mutable so a 404 can be fixed between inits. */
function installFetch(sizes: Record<string, number>): FetchStub {
  const stub: FetchStub = { sizes, calls: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    stub.calls.push(url);
    const name = Object.keys(stub.sizes).find((k) => url.endsWith(k));
    if (!name) return new Response(null, { status: 404 });
    const size = stub.sizes[name]!;
    const chunk = new Uint8Array(size);
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(chunk.subarray(0, size >> 1)); c.enqueue(chunk.subarray(size >> 1)); c.close(); },
    });
    return new Response(body, { status: 200, headers: { 'content-length': String(size) } });
  }));
  return stub;
}

function fakeVideo(currentTime: number, videoWidth = 1280, videoHeight = 720): HTMLVideoElement {
  // Minimal structural stand-in; the tracker only reads these fields (and draws it) in tests.
  return { currentTime, videoWidth, videoHeight, readyState: 4 } as unknown as HTMLVideoElement;
}

interface FakeCanvas {
  width: number;
  height: number;
  draws: { src: unknown; args: number[] }[];
  getContext(id: string): unknown;
}

/** Injectable canvas factory: records every canvas created and every drawImage call. */
function canvasFactory() {
  const created: FakeCanvas[] = [];
  const factory = vi.fn((width: number, height: number): OffscreenCanvas => {
    const canvas: FakeCanvas = {
      width,
      height,
      draws: [],
      getContext: (id) => (id === '2d' ? { drawImage: (src: unknown, ...args: number[]) => { canvas.draws.push({ src, args }); } } : null),
    };
    created.push(canvas);
    return canvas as unknown as OffscreenCanvas;
  });
  return { factory, created };
}

const face478 = () => Array.from({ length: 478 }, (_, i) => ({ x: 0.5 + (i % 7) * 0.001, y: 0.5 + (i % 5) * 0.001, z: 0 }));
const withFace = () => {
  state.faceResult = { faceLandmarks: [face478()], faceBlendshapes: [{ categories: [{ categoryName: 'jawOpen', score: 0.3 }] }], facialTransformationMatrixes: [] };
};
const kinds = (kind: string) => state.inputs.filter((i) => i.kind === kind);

beforeEach(() => {
  state.inputs.length = 0;
  state.faceCalls = 0;
  state.handResult = { landmarks: [], handedness: [] };
  state.faceResult = { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
  vi.mocked(FilesetResolver.forVisionTasks).mockClear();
  vi.mocked(HandLandmarker.createFromOptions).mockClear();
  installFetch({ 'hand_landmarker.task': 1000, 'face_landmarker.task': 500, 'selfie_segmenter.tflite': 100 });
});

describe('inferenceTarget / evenSize (pure)', () => {
  it('evenSize rounds to the nearest even integer and never goes below 2', () => {
    expect(evenSize(853.3)).toBe(854);
    expect(evenSize(855)).toBe(856);
    expect(evenSize(480)).toBe(480);
    expect(evenSize(1)).toBe(2);
    expect(evenSize(0)).toBe(2);
  });

  it('downscales only sources taller than maxHeight: height = cap, width by aspect, both even', () => {
    expect(inferenceTarget(1280, 720, 480)).toEqual({ width: 854, height: 480 });
    expect(inferenceTarget(1280, 720, 360)).toEqual({ width: 640, height: 360 });
    expect(inferenceTarget(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
    expect(inferenceTarget(1080, 1920, 480)).toEqual({ width: 270, height: 480 });
    expect(inferenceTarget(1279, 719, 480)).toEqual({ width: 854, height: 480 });
  });

  it('returns null when no downscale is needed or the inputs are degenerate', () => {
    expect(inferenceTarget(1280, 720, 720)).toBeNull();
    expect(inferenceTarget(640, 360, 480)).toBeNull();
    expect(inferenceTarget(1280, 720, 0)).toBeNull();
    expect(inferenceTarget(0, 0, 480)).toBeNull();
  });
});

describe('inferenceMaxHeight (mocked MediaPipe)', () => {
  it('draws a 1280×720 source ONCE per analysed frame into an even 854×480 canvas shared by hands, face and segmentation', async () => {
    const { factory, created } = canvasFactory();
    const tracker = createTracker({ inferenceMaxHeight: 480, createCanvas: factory });
    await tracker.init();
    expect(factory).not.toHaveBeenCalled(); // allocated lazily on the first analysed frame

    const v1 = fakeVideo(1);
    tracker.update(v1, 33);
    tracker.update(fakeVideo(2), 66);
    tracker.update(fakeVideo(3), 99);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(854, 480);
    const canvas = created[0]!;
    // One resample per analysed frame — not one per task.
    expect(canvas.draws).toHaveLength(3);
    expect(canvas.draws[0]!.src).toBe(v1);
    expect(canvas.draws[0]!.args).toEqual([0, 0, 854, 480]);
    // The canvas (never the video) is what every task sees, on every frame.
    expect(kinds('hand')).toHaveLength(3);
    expect(kinds('face')).toHaveLength(3);
    expect(kinds('seg')).toHaveLength(3);
    expect(state.inputs.every((i) => i.src === canvas)).toBe(true);
    expect(tracker.getInfo().inferenceSize).toEqual({ width: 854, height: 480 });

    // An unchanged decoded frame (same currentTime) returns the cached result without a redraw.
    const same = fakeVideo(3);
    const before = state.inputs.length;
    tracker.update(same, 132);
    expect(canvas.draws).toHaveLength(3);
    expect(state.inputs.length).toBe(before);
  });

  it('passes the video itself when it is not taller than inferenceMaxHeight (default 720) — no canvas, no copy', async () => {
    const { factory } = canvasFactory();
    const tracker = createTracker({ createCanvas: factory });
    await tracker.init();
    expect(tracker.getInfo().inferenceSize).toBeNull();
    const v = fakeVideo(1);
    tracker.update(v, 33);
    tracker.update(fakeVideo(2), 66);
    expect(factory).not.toHaveBeenCalled();
    expect(state.inputs).toHaveLength(6);
    expect(state.inputs.every((i) => i.src === v || (i.src as HTMLVideoElement).currentTime === 2)).toBe(true);
    expect(state.inputs[0]!.src).toBe(v);
    expect(tracker.getInfo().inferenceSize).toEqual({ width: 1280, height: 720 });
  });

  it('a 1080p source is downscaled to 1280×720 at the default inferenceMaxHeight', async () => {
    const { factory, created } = canvasFactory();
    const tracker = createTracker({ createCanvas: factory });
    await tracker.init();
    tracker.update(fakeVideo(1, 1920, 1080), 33);
    expect(factory).toHaveBeenCalledWith(1280, 720);
    expect(state.inputs.every((i) => i.src === created[0])).toBe(true);
    expect(tracker.getInfo().inferenceSize).toEqual({ width: 1280, height: 720 });
    const f = tracker.update(fakeVideo(2, 1920, 1080), 66);
    // The frame keeps describing the SOURCE; landmarks are normalized so nothing is remapped.
    expect(f.sourceWidth).toBe(1920);
    expect(f.sourceHeight).toBe(1080);
  });

  it('live setOptions({ inferenceMaxHeight }) applies on the next frame: canvas resized, passthrough restored, canvas reused', async () => {
    const { factory, created } = canvasFactory();
    const tracker = createTracker({ inferenceMaxHeight: 480, createCanvas: factory });
    await tracker.init();
    tracker.update(fakeVideo(1), 33);
    expect(created[0]!.width).toBe(854);

    tracker.setOptions({ inferenceMaxHeight: 360 });
    tracker.update(fakeVideo(2), 66);
    const input = state.inputs[state.inputs.length - 1]!.src as FakeCanvas;
    expect(input.width).toBe(640);
    expect(input.height).toBe(360);
    expect(input.draws[input.draws.length - 1]!.args).toEqual([0, 0, 640, 360]);
    expect(tracker.getInfo().inferenceSize).toEqual({ width: 640, height: 360 });
    expect(factory).toHaveBeenCalledTimes(1); // resized in place, not leaked

    tracker.setOptions({ inferenceMaxHeight: 720 });
    const v3 = fakeVideo(3);
    const drawsBefore = created[0]!.draws.length;
    tracker.update(v3, 99);
    expect(state.inputs[state.inputs.length - 1]!.src).toBe(v3);
    expect(created[0]!.draws).toHaveLength(drawsBefore); // no copy when not downscaling
    expect(tracker.getInfo().inferenceSize).toEqual({ width: 1280, height: 720 });

    tracker.setOptions({ inferenceMaxHeight: 480 });
    tracker.update(fakeVideo(4), 132);
    expect(factory).toHaveBeenCalledTimes(1);
    const again = state.inputs[state.inputs.length - 1]!.src as FakeCanvas;
    expect(again).toBe(created[0]);
    expect(again.width).toBe(854);
    expect(again.height).toBe(480);
  });

  it('without any canvas implementation (Node, no factory) it warns once and feeds the source at native size', async () => {
    const tracker = createTracker({ inferenceMaxHeight: 480 });
    await tracker.init();
    const v = fakeVideo(1);
    tracker.update(v, 33);
    tracker.update(fakeVideo(2), 66);
    expect(state.inputs[0]!.src).toBe(v);
    expect(tracker.getInfo().inferenceSize).toEqual({ width: 1280, height: 720 });
    const warnings = tracker.getInfo().warnings.filter((w) => /downscale/i.test(w));
    expect(warnings).toHaveLength(1);
  });

  it('dispose drops the inference canvas and size', async () => {
    const { factory } = canvasFactory();
    const tracker = createTracker({ inferenceMaxHeight: 480, createCanvas: factory });
    await tracker.init();
    tracker.update(fakeVideo(1), 33);
    tracker.dispose();
    expect(tracker.getInfo().inferenceSize).toBeNull();
  });
});

describe('faceStride (mocked MediaPipe)', () => {
  it('runs the face landmarker every N analysed frames and reuses the SAME FaceTrack object in between (faceMs 0)', async () => {
    withFace();
    const tracker = createTracker({ faceStride: 3, enableSegmentation: false });
    await tracker.init();
    const frames = [1, 2, 3, 4, 5, 6].map((i) => tracker.update(fakeVideo(i), i * 33));
    expect(state.faceCalls).toBe(2); // frames 1 and 4
    expect(kinds('hand')).toHaveLength(6); // hands still run every frame
    expect(frames.every((f) => f.face !== null)).toBe(true);
    // Identity compared as booleans so a failure prints true/false rather than 478 landmarks.
    const same = (a: number, b: number): boolean => frames[a]!.face === frames[b]!.face;
    expect(same(1, 0)).toBe(true);
    expect(same(2, 0)).toBe(true);
    expect(same(3, 0)).toBe(false);
    expect(same(4, 3)).toBe(true);
    expect(same(5, 3)).toBe(true);
    expect(frames[1]!.timings.faceMs).toBe(0);
    expect(frames[2]!.timings.faceMs).toBe(0);
    expect(frames[0]!.timings.faceMs).toBeGreaterThanOrEqual(0);
  });

  it('drops the reused face after smoothingResetMs (500 ms) without a face run that saw a face', async () => {
    withFace();
    const tracker = createTracker({ faceStride: 3, enableSegmentation: false });
    await tracker.init();
    const f1 = tracker.update(fakeVideo(1), 0);
    expect(f1.face).not.toBeNull();
    const f2 = tracker.update(fakeVideo(2), 600); // skipped frame, > 500 ms since the last face run
    expect(f2.face === null).toBe(true); // boolean form: a failure prints true/false, not 478 landmarks
    const f3 = tracker.update(fakeVideo(3), 650); // still skipped
    expect(f3.face === null).toBe(true);
    const f4 = tracker.update(fakeVideo(4), 700); // face runs again
    expect(f4.face).not.toBeNull();
    expect(f4.face === f1.face).toBe(false);
    expect(state.faceCalls).toBe(2);
  });

  it('a face run that sees no face clears the reused track for the following stride frames', async () => {
    withFace();
    const tracker = createTracker({ faceStride: 3, enableSegmentation: false });
    await tracker.init();
    const frames = [1, 2, 3].map((i) => tracker.update(fakeVideo(i), i * 33));
    expect(frames.every((f) => f.face !== null)).toBe(true);
    state.faceResult = { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
    const more = [4, 5, 6].map((i) => tracker.update(fakeVideo(i), i * 33));
    expect(more.every((f) => f.face === null)).toBe(true);
    expect(state.faceCalls).toBe(2);
  });

  it('faceStride 1 (default) runs the face every frame and yields a fresh FaceTrack per frame (v0.1 behaviour)', async () => {
    withFace();
    const tracker = createTracker({ enableSegmentation: false });
    await tracker.init();
    const frames = [1, 2, 3].map((i) => tracker.update(fakeVideo(i), i * 33));
    expect(state.faceCalls).toBe(3);
    expect(frames[1]!.face === frames[0]!.face).toBe(false);
    expect(frames[2]!.face === frames[1]!.face).toBe(false);
  });

  it('setOptions({ faceStride }) changes the cadence live', async () => {
    withFace();
    const tracker = createTracker({ enableSegmentation: false });
    await tracker.init();
    tracker.update(fakeVideo(1), 33);
    tracker.update(fakeVideo(2), 66);
    expect(state.faceCalls).toBe(2);
    tracker.setOptions({ faceStride: 2 });
    tracker.update(fakeVideo(3), 99);  // analysed frame 3 → (3-1) % 2 === 0 → runs
    tracker.update(fakeVideo(4), 132); // skipped
    tracker.update(fakeVideo(5), 165); // runs
    expect(state.faceCalls).toBe(4);
  });
});

describe('re-entrant init (mocked MediaPipe)', () => {
  it('retries after a model 404: fileset reused, cached models not re-fetched, progress restarts at 0 and reaches 1, ready', async () => {
    const stub = installFetch({ 'hand_landmarker.task': 1000, 'face_landmarker.task': 500 }); // segmenter missing
    const first: number[] = [];
    const second: number[] = [];
    let bucket = first;
    const tracker = createTracker({}, (p) => bucket.push(p));

    await expect(tracker.init()).rejects.toThrow(/selfie_segmenter\.tflite.*404/);
    expect(tracker.ready).toBe(false);
    expect(first[0]).toBe(0);
    expect(first[first.length - 1]!).toBeLessThan(1);

    stub.sizes['selfie_segmenter.tflite'] = 100; // "the file is there now"
    bucket = second;
    await tracker.init();
    expect(tracker.ready).toBe(true);
    expect(second[0]).toBe(0);
    expect(second[second.length - 1]).toBe(1);
    for (let i = 1; i < second.length; i++) expect(second[i]!).toBeGreaterThanOrEqual(second[i - 1]!);

    // The wasm fileset and the models that did download are reused; only the missing one is fetched again.
    expect(vi.mocked(FilesetResolver.forVisionTasks)).toHaveBeenCalledTimes(1);
    expect(stub.calls.filter((u) => u.endsWith('hand_landmarker.task'))).toHaveLength(1);
    expect(stub.calls.filter((u) => u.endsWith('face_landmarker.task'))).toHaveLength(1);
    expect(stub.calls.filter((u) => u.endsWith('selfie_segmenter.tflite'))).toHaveLength(2);
    expect(tracker.getInfo().delegates).toEqual({ hands: 'GPU', face: 'GPU', segmentation: 'CPU' });

    // And it tracks afterwards.
    const f = tracker.update(fakeVideo(1), 33);
    expect(f.segmentation).not.toBeNull();
  });

  it('is idempotent while the retry is in flight (same promise, tasks built once)', async () => {
    const stub = installFetch({ 'hand_landmarker.task': 1000, 'face_landmarker.task': 500 });
    const tracker = createTracker();
    await expect(tracker.init()).rejects.toThrow(/404/);
    stub.sizes['selfie_segmenter.tflite'] = 100;
    const a = tracker.init();
    const b = tracker.init();
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(tracker.ready).toBe(true);
    expect(vi.mocked(HandLandmarker.createFromOptions)).toHaveBeenCalledTimes(1);
  });

  it('a failure during task construction is retried cleanly (tasks rebuilt, nothing leaked as ready)', async () => {
    let fail = true;
    vi.mocked(HandLandmarker.createFromOptions).mockImplementationOnce(async () => { if (fail) throw new Error('hand: CPU init failed'); return undefined as never; });
    const tracker = createTracker({ delegate: 'CPU' });
    await expect(tracker.init()).rejects.toThrow(/hand: CPU init failed/);
    expect(tracker.ready).toBe(false);
    fail = false;
    await tracker.init();
    expect(tracker.ready).toBe(true);
    expect(vi.mocked(FilesetResolver.forVisionTasks)).toHaveBeenCalledTimes(1);
    expect(tracker.getInfo().delegates.hands).toBe('CPU');
  });
});
