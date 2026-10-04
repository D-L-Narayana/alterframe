/**
 * MediaPipe timestamp contract (mocked MediaPipe). The tasks key packets by INTEGER microseconds
 * (`ms × 1000`, truncated) and require them to be strictly increasing per task. The tracker owns
 * that contract: whatever `t` the caller passes (a 1 µs re-render step, a clock going backwards,
 * fractional milliseconds), the timestamps handed to the tasks must be integers that strictly
 * increase — otherwise the graph throws ("Packet timestamp mismatch … free_memory") and
 * `handleTaskError` would silently rebuild the task on CPU.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ handTimestamps: [] as number[], faceTimestamps: [] as number[], segTimestamps: [] as number[] }));

vi.mock('@mediapipe/tasks-vision', () => {
  const make = (kind: string) => ({
    createFromOptions: vi.fn(async () => ({
      close: () => undefined,
      detectForVideo: (_v: unknown, ts: number) => {
        (kind === 'hand' ? state.handTimestamps : state.faceTimestamps).push(ts);
        return { landmarks: [], handedness: [], faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
      },
      segmentForVideo: (_v: unknown, ts: number) => { state.segTimestamps.push(ts); },
      getLabels: () => ['selfie'],
    })),
  });
  return {
    FilesetResolver: { forVisionTasks: vi.fn(async () => ({})) },
    HandLandmarker: make('hand'),
    FaceLandmarker: make('face'),
    ImageSegmenter: make('seg'),
  };
});

import { createTracker } from '../../../src/tracking';

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(16), { status: 200, headers: { 'content-length': '16' } })));
}

/** Each call is a NEW decoded frame (distinct currentTime) so the same-frame cache never short-circuits. */
let frameNo = 0;
const nextVideo = (): HTMLVideoElement => ({ currentTime: ++frameNo * 0.0333, videoWidth: 1280, videoHeight: 720, readyState: 4 } as unknown as HTMLVideoElement);

/** The microsecond key MediaPipe derives from a millisecond timestamp. */
const micros = (ms: number): number => Math.floor(ms * 1000);

beforeEach(() => {
  state.handTimestamps.length = 0;
  state.faceTimestamps.length = 0;
  state.segTimestamps.length = 0;
  installFetch();
});

describe('timestamps handed to MediaPipe', () => {
  it('two frames 1 µs apart (runtime requestRender re-run) land on distinct integer microsecond packets', async () => {
    const tracker = createTracker({ enableFace: false, enableSegmentation: false });
    await tracker.init();
    const a = tracker.update(nextVideo(), 13256.0);
    const b = tracker.update(nextVideo(), 13256.001);
    const [ts1, ts2] = state.handTimestamps as [number, number];
    expect(Number.isInteger(ts1)).toBe(true);
    expect(Number.isInteger(ts2)).toBe(true);
    expect(micros(ts2)).toBeGreaterThan(micros(ts1));
    // The frame keeps the caller's clock.
    expect(a.t).toBe(13256.0);
    expect(b.t).toBe(13256.001);
  });

  it('a sub-millisecond step (0.4 µs) must still yield a distinct, later microsecond packet', async () => {
    // With float milliseconds 13256.0004 × 1000 truncates to the same 13256000 µs as 13256.0 — the
    // duplicate-packet case MediaPipe rejects ("Packet timestamp mismatch … free_memory").
    const tracker = createTracker({ enableFace: false, enableSegmentation: false });
    await tracker.init();
    tracker.update(nextVideo(), 13256.0);
    tracker.update(nextVideo(), 13256.0004);
    const [ts1, ts2] = state.handTimestamps as [number, number];
    expect(micros(ts2)).toBeGreaterThan(micros(ts1));
    expect(Number.isInteger(ts1) && Number.isInteger(ts2)).toBe(true);
  });

  it('fractional milliseconds are floored and still strictly increase by at least 1 ms', async () => {
    const tracker = createTracker({ enableFace: false, enableSegmentation: false });
    await tracker.init();
    for (const t of [100.4, 100.6, 100.9, 101.2]) tracker.update(nextVideo(), t);
    const ts = state.handTimestamps;
    expect(ts).toHaveLength(4);
    for (const v of ts) expect(Number.isInteger(v)).toBe(true);
    for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(1);
    expect(ts[0]).toBe(100);
  });

  it('a clock going backwards (600 → 500) still yields strictly increasing integers', async () => {
    const tracker = createTracker({ enableFace: false, enableSegmentation: false });
    await tracker.init();
    tracker.update(nextVideo(), 600);
    tracker.update(nextVideo(), 500);
    tracker.update(nextVideo(), 500.0005);
    const ts = state.handTimestamps;
    expect(ts[0]).toBe(600);
    expect(ts[1]!).toBeGreaterThan(ts[0]!);
    expect(ts[2]!).toBeGreaterThan(ts[1]!);
    for (const v of ts) expect(Number.isInteger(v)).toBe(true);
  });

  it('all three tasks receive the same integer timestamp for one analysed frame', async () => {
    const tracker = createTracker();
    await tracker.init();
    tracker.update(nextVideo(), 2000.75);
    tracker.update(nextVideo(), 2000.751);
    expect(state.handTimestamps).toEqual(state.faceTimestamps);
    expect(state.handTimestamps).toEqual(state.segTimestamps);
    expect(state.handTimestamps.every((v) => Number.isInteger(v))).toBe(true);
    expect(micros(state.handTimestamps[1]!)).toBeGreaterThan(micros(state.handTimestamps[0]!));
  });
});
