import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRecorder } from '@/capture/recorder';
import type { MediaRecorderCtor, MediaRecorderLike, RecorderDeps, CanvasLike } from '@/capture/recorder';

/* ---------- fakes ---------- */

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

interface Fake2d {
  calls: unknown[][];
  drawImage: (...args: unknown[]) => void;
}

function fakeCanvas(width: number, height: number, label: string) {
  const ctx: Fake2d = { calls: [], drawImage: (...args) => ctx.calls.push(args) };
  const stream = new FakeStream();
  const toBlobCalls: unknown[][] = [];
  const canvas = {
    label,
    width,
    height,
    getContext: vi.fn(() => ctx),
    captureStream: vi.fn(() => stream),
    // Snapshot encoder fake: echoes the requested type (a browser that supports every format).
    toBlob: (cb: (b: Blob | null) => void, type?: string, quality?: number) => {
      toBlobCalls.push([type, quality]);
      cb(new Blob(['img'], { type: type ?? '' }));
    },
  };
  return { canvas: canvas as unknown as CanvasLike & { label: string }, ctx, stream, toBlobCalls };
}

type Listener = (ev: { data?: Blob; error?: Error }) => void;

class FakeMediaRecorder implements MediaRecorderLike {
  static instances: FakeMediaRecorder[] = [];
  static supported: Set<string> = new Set(['video/webm;codecs=vp9', 'video/webm']);
  static isTypeSupported(m: string) {
    return FakeMediaRecorder.supported.has(m);
  }
  static throwOnConstruct: Error | null = null;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  readonly stream: unknown;
  readonly options: MediaRecorderOptions;
  startArgs: unknown[] = [];
  listeners = new Map<string, Listener[]>();
  autoStop = true;
  constructor(stream: unknown, options: MediaRecorderOptions) {
    if (FakeMediaRecorder.throwOnConstruct) throw FakeMediaRecorder.throwOnConstruct;
    this.stream = stream;
    this.options = options;
    this.mimeType = options.mimeType ?? '';
    FakeMediaRecorder.instances.push(this);
  }
  addEventListener(type: string, cb: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, cb: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== cb));
  }
  emit(type: string, ev: { data?: Blob; error?: Error } = {}) {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  start(...args: unknown[]) {
    this.startArgs = args;
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    if (this.autoStop) {
      // Real recorders flush a final dataavailable, then fire stop, asynchronously.
      queueMicrotask(() => {
        this.emit('dataavailable', { data: new Blob(['tail'], { type: 'video/webm' }) });
        this.emit('stop');
      });
    }
  }
  requestData() {
    /* noop */
  }
  pushChunk(bytes: string) {
    this.emit('dataavailable', { data: new Blob([bytes], { type: 'video/webm' }) });
  }
}

/* ---------- harness ---------- */

function setup(width = 1280, height = 720) {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.throwOnConstruct = null;
  FakeMediaRecorder.supported = new Set(['video/webm;codecs=vp9', 'video/webm']);
  const source = fakeCanvas(width, height, 'source');
  const created: ReturnType<typeof fakeCanvas>[] = [];
  let t = 1000;
  const rafQueue: Array<{ id: number; cb: () => void }> = [];
  let rafId = 0;
  const cancelled: number[] = [];
  const stateLog: string[] = [];
  const deps: RecorderDeps = {
    MediaRecorder: FakeMediaRecorder as unknown as MediaRecorderCtor,
    now: () => t,
    requestFrame: (cb) => {
      const id = ++rafId;
      rafQueue.push({ id, cb });
      return id;
    },
    cancelFrame: (id) => {
      cancelled.push(id);
      const i = rafQueue.findIndex((r) => r.id === id);
      if (i >= 0) rafQueue.splice(i, 1);
    },
    createCanvas: (w, h) => {
      const c = fakeCanvas(w, h, 'crop');
      created.push(c);
      return c.canvas;
    },
    onStateChange: (s) => stateLog.push(s),
  };
  const recorder = createRecorder(() => source.canvas as unknown as HTMLCanvasElement, deps);
  const tick = () => {
    const batch = rafQueue.splice(0, rafQueue.length);
    for (const r of batch) r.cb();
  };
  return {
    recorder,
    source,
    created,
    tick,
    rafQueue,
    cancelled,
    stateLog,
    advance: (ms: number) => {
      t += ms;
    },
    mr: () => FakeMediaRecorder.instances[0]!,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ---------- tests ---------- */

describe('createRecorder — state machine', () => {
  it('starts idle with zero elapsed', () => {
    const { recorder } = setup();
    expect(recorder.state).toBe('idle');
    expect(recorder.elapsedMs).toBe(0);
  });

  it('start() picks the first supported mime, passes bitrate, starts with a timeslice and records from the source canvas', async () => {
    const { recorder, source, mr, stateLog } = setup();
    await recorder.start({ aspect: 'source', fps: 24, videoBitsPerSecond: 5_000_000 });
    expect(recorder.state).toBe('recording');
    expect(source.canvas.captureStream).toHaveBeenCalledWith(24);
    expect(mr().stream).toBe(source.stream);
    expect(mr().options).toEqual({ mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 5_000_000 });
    expect(mr().startArgs[0]).toBeTypeOf('number');
    expect(stateLog).toEqual(['recording']);
  });

  it('uses defaults: 30 fps and 12 Mbps', async () => {
    const { recorder, source, mr } = setup();
    await recorder.start({ aspect: 'source' });
    expect(source.canvas.captureStream).toHaveBeenCalledWith(30);
    expect(mr().options.videoBitsPerSecond).toBe(12_000_000);
  });

  it('elapsedMs tracks wall time while recording', async () => {
    const { recorder, advance } = setup();
    await recorder.start({ aspect: 'source' });
    advance(1234);
    expect(recorder.elapsedMs).toBe(1234);
  });

  it('stop() resolves with a Blob of all chunks, the mime, the duration, and returns to idle', async () => {
    const { recorder, mr, advance, source, stateLog } = setup();
    await recorder.start({ aspect: 'source' });
    mr().pushChunk('abc');
    advance(2500);
    const p = recorder.stop();
    expect(recorder.state).toBe('finalizing');
    const result = await p;
    expect(result.mime).toBe('video/webm;codecs=vp9');
    expect(result.durationMs).toBe(2500);
    expect(result.blob.type).toBe('video/webm');
    expect(result.blob.size).toBe('abc'.length + 'tail'.length);
    expect(recorder.state).toBe('idle');
    expect(recorder.elapsedMs).toBe(0);
    expect(source.stream.tracks[0]!.stopped).toBe(true);
    expect(stateLog).toEqual(['recording', 'finalizing', 'idle']);
  });

  it('elapsedMs is frozen while finalizing', async () => {
    const { recorder, advance } = setup();
    await recorder.start({ aspect: 'source' });
    advance(1000);
    const p = recorder.stop();
    advance(5000);
    expect(recorder.elapsedMs).toBe(1000);
    await p;
  });

  it('start() while recording rejects with a readable message and leaves the recording intact', async () => {
    const { recorder } = setup();
    await recorder.start({ aspect: 'source' });
    await expect(recorder.start({ aspect: 'source' })).rejects.toThrow(/already recording/i);
    expect(recorder.state).toBe('recording');
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it('stop() while idle rejects', async () => {
    const { recorder } = setup();
    await expect(recorder.stop()).rejects.toThrow(/not recording/i);
  });

  it('a second stop() during finalizing returns the same result', async () => {
    const { recorder } = setup();
    await recorder.start({ aspect: 'source' });
    const a = recorder.stop();
    const b = recorder.stop();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
  });

  it('can record again after stopping', async () => {
    const { recorder } = setup();
    await recorder.start({ aspect: 'source' });
    await recorder.stop();
    await recorder.start({ aspect: 'source' });
    expect(recorder.state).toBe('recording');
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    await recorder.stop();
  });
});

describe('createRecorder — aspect crops', () => {
  it('9:16 records from an intermediate 1080×1920 canvas that is redrawn each animation frame with the centre crop', async () => {
    const { recorder, created, source, tick, rafQueue, mr } = setup(1920, 1080);
    await recorder.start({ aspect: '9:16' });
    expect(created).toHaveLength(1);
    const crop = created[0]!;
    expect(crop.canvas.width).toBe(1080);
    expect(crop.canvas.height).toBe(1920);
    expect(mr().stream).toBe(crop.stream);
    expect(source.canvas.captureStream).not.toHaveBeenCalled();
    // One synchronous draw so the first encoded frame is not blank.
    expect(crop.ctx.calls).toHaveLength(1);
    expect(crop.ctx.calls[0]).toEqual([source.canvas, 656, 0, 608, 1080, 0, 0, 1080, 1920]);
    expect(rafQueue).toHaveLength(1);
    tick();
    tick();
    expect(crop.ctx.calls).toHaveLength(3);
    expect(rafQueue).toHaveLength(1); // keeps rescheduling
  });

  it('16:9 and 1:1 produce 1920×1080 and 1080×1080 crop canvases', async () => {
    for (const [aspect, w, h] of [
      ['16:9', 1920, 1080],
      ['1:1', 1080, 1080],
    ] as const) {
      const { recorder, created } = setup(1280, 720);
      await recorder.start({ aspect });
      expect(created[0]!.canvas.width).toBe(w);
      expect(created[0]!.canvas.height).toBe(h);
      await recorder.stop();
    }
  });

  it('follows a source resize mid-recording (crop recomputed, output size fixed)', async () => {
    const { recorder, created, source, tick } = setup(1920, 1080);
    await recorder.start({ aspect: '1:1' });
    (source.canvas as { width: number }).width = 1280;
    (source.canvas as { height: number }).height = 720;
    tick();
    const last = created[0]!.ctx.calls.at(-1)!;
    expect(last).toEqual([source.canvas, 280, 0, 720, 720, 0, 0, 1080, 1080]);
  });

  it('stop() cancels the animation loop and releases the crop canvas', async () => {
    const { recorder, created, tick, rafQueue, cancelled } = setup(1920, 1080);
    await recorder.start({ aspect: '9:16' });
    tick();
    await recorder.stop();
    expect(rafQueue).toHaveLength(0);
    expect(cancelled.length).toBeGreaterThan(0);
    expect(created[0]!.canvas.width).toBe(0); // memory released
    expect(created[0]!.stream.tracks[0]!.stopped).toBe(true);
  });

  it('source aspect never allocates an intermediate canvas', async () => {
    const { recorder, created, rafQueue } = setup();
    await recorder.start({ aspect: 'source' });
    expect(created).toHaveLength(0);
    expect(rafQueue).toHaveLength(0);
  });
});

describe('createRecorder — errors', () => {
  it('rejects readably when no mime candidate is supported, staying idle', async () => {
    const { recorder } = setup();
    FakeMediaRecorder.supported = new Set();
    await expect(recorder.start({ aspect: 'source' })).rejects.toThrow(/no supported video format/i);
    expect(recorder.state).toBe('idle');
  });

  it('respects a custom mimeCandidates list', async () => {
    const { recorder, mr } = setup();
    await recorder.start({ aspect: 'source', mimeCandidates: ['video/webm'] });
    expect(mr().options.mimeType).toBe('video/webm');
  });

  it('rejects when MediaRecorder is unavailable', async () => {
    const source = fakeCanvas(640, 360, 'source');
    const recorder = createRecorder(() => source.canvas as unknown as HTMLCanvasElement, {
      MediaRecorder: undefined,
    });
    await expect(recorder.start({ aspect: 'source' })).rejects.toThrow(/MediaRecorder.*not supported/i);
  });

  it('rejects when the canvas cannot produce a stream', async () => {
    const source = fakeCanvas(640, 360, 'source');
    (source.canvas as { captureStream?: unknown }).captureStream = undefined;
    const recorder = createRecorder(() => source.canvas as unknown as HTMLCanvasElement, {
      MediaRecorder: FakeMediaRecorder as unknown as MediaRecorderCtor,
    });
    await expect(recorder.start({ aspect: 'source' })).rejects.toThrow(/captureStream/i);
  });

  it('rejects when the canvas is empty', async () => {
    const { recorder } = setup(0, 0);
    await expect(recorder.start({ aspect: '1:1' })).rejects.toThrow(/empty|zero/i);
    expect(recorder.state).toBe('idle');
  });

  it('wraps MediaRecorder constructor failures and stops the stream', async () => {
    const { recorder, source } = setup();
    FakeMediaRecorder.throwOnConstruct = new DOMException('bad bitrate', 'NotSupportedError');
    await expect(recorder.start({ aspect: 'source' })).rejects.toThrow(/could not start recording.*bad bitrate/i);
    expect(recorder.state).toBe('idle');
    expect(source.stream.tracks[0]!.stopped).toBe(true);
  });

  it('a recorder error mid-recording resets to idle, and the next stop() reports it', async () => {
    const { recorder, mr, source, stateLog } = setup();
    await recorder.start({ aspect: 'source' });
    mr().emit('error', { error: new Error('disk full') });
    expect(recorder.state).toBe('idle');
    expect(source.stream.tracks[0]!.stopped).toBe(true);
    await expect(recorder.stop()).rejects.toThrow(/recording failed.*disk full/i);
    expect(stateLog).toEqual(['recording', 'idle']);
    // error is consumed: a plain idle stop afterwards is the ordinary "not recording"
    await expect(recorder.stop()).rejects.toThrow(/not recording/i);
  });

  it('stop() rejects when the recorder produced no data', async () => {
    const { recorder, mr } = setup();
    await recorder.start({ aspect: 'source' });
    mr().autoStop = false;
    const p = recorder.stop();
    mr().emit('stop');
    await expect(p).rejects.toThrow(/no data/i);
    expect(recorder.state).toBe('idle');
  });

  it('stop() does not hang if the stop event never fires: resolves with collected chunks after a timeout', async () => {
    const { recorder, mr } = setup();
    await recorder.start({ aspect: 'source' });
    mr().autoStop = false;
    mr().pushChunk('xyz');
    const p = recorder.stop();
    await vi.advanceTimersByTimeAsync(6000);
    const r = await p;
    expect(r.blob.size).toBe(3);
    expect(recorder.state).toBe('idle');
  });
});

describe('createRecorder — maxDurationMs (self-finalize + pending result)', () => {
  it('starts with no pending result', () => {
    const { recorder } = setup();
    expect(recorder.hasPendingResult).toBe(false);
  });

  it('defaults to a 600 s cap: the recording finalizes on its own exactly when it is reached', async () => {
    const { recorder, mr, advance, stateLog } = setup();
    await recorder.start({ aspect: 'source' });
    mr().pushChunk('abc');
    advance(599_999);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(recorder.state).toBe('recording');
    expect(recorder.hasPendingResult).toBe(false);
    advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stateLog).toEqual(['recording', 'finalizing', 'idle']);
    expect(recorder.state).toBe('idle');
    expect(recorder.hasPendingResult).toBe(true);
  });

  it('a custom cap finalizes early (same path as stop); stop() then resolves once with the pending result', async () => {
    const { recorder, mr, advance, stateLog, source } = setup();
    await recorder.start({ aspect: 'source', maxDurationMs: 1500 });
    mr().pushChunk('abc');
    advance(1500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(stateLog).toEqual(['recording', 'finalizing', 'idle']);
    expect(recorder.state).toBe('idle');
    expect(recorder.elapsedMs).toBe(0);
    expect(recorder.hasPendingResult).toBe(true);
    expect(source.stream.tracks[0]!.stopped).toBe(true);
    expect(mr().state).toBe('inactive');

    const result = await recorder.stop();
    expect(result.durationMs).toBe(1500);
    expect(result.mime).toBe('video/webm;codecs=vp9');
    expect(result.blob.type).toBe('video/webm');
    expect(result.blob.size).toBe('abc'.length + 'tail'.length);
    expect(recorder.hasPendingResult).toBe(false);
    expect(recorder.state).toBe('idle');
    // Collected exactly once: a second stop() is the ordinary idle rejection.
    await expect(recorder.stop()).rejects.toThrow(/not recording/i);
    expect(stateLog).toEqual(['recording', 'finalizing', 'idle']); // collecting does not re-enter finalizing
  });

  it('hasPendingResult is already true when onStateChange reports idle (no race for the UI)', async () => {
    setup(); // resets the FakeMediaRecorder registry
    const seen: Array<[string, boolean | undefined]> = [];
    const source = fakeCanvas(1280, 720, 'source');
    let t = 0;
    // onStateChange reads hasPendingResult synchronously, exactly like a store mirror would.
    const recorder = createRecorder(() => source.canvas as unknown as HTMLCanvasElement, {
      MediaRecorder: FakeMediaRecorder as unknown as MediaRecorderCtor,
      now: () => t,
      onStateChange: (s) => seen.push([s, recorder.hasPendingResult]),
    });
    await recorder.start({ aspect: 'source', maxDurationMs: 1000 });
    FakeMediaRecorder.instances.at(-1)!.pushChunk('abc');
    t = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([
      ['recording', false],
      ['finalizing', false],
      ['idle', true],
    ]);
  });

  it('start() while a pending result waits rejects readably and keeps the result for stop()', async () => {
    const { recorder, mr, advance } = setup();
    await recorder.start({ aspect: 'source', maxDurationMs: 1000 });
    mr().pushChunk('abc');
    advance(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(recorder.hasPendingResult).toBe(true);
    await expect(recorder.start({ aspect: 'source' })).rejects.toThrow(/collect the previous recording with stop\(\) first/i);
    expect(recorder.state).toBe('idle');
    expect(recorder.hasPendingResult).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    const result = await recorder.stop();
    expect(result.blob.size).toBeGreaterThan(0);
    // Once collected, recording can start again.
    await recorder.start({ aspect: 'source' });
    expect(recorder.state).toBe('recording');
    expect(FakeMediaRecorder.instances).toHaveLength(2);
  });

  it('a user stop() before the cap cancels the timer: no second finalize, nothing pending', async () => {
    const { recorder, mr, advance, stateLog } = setup();
    await recorder.start({ aspect: 'source', maxDurationMs: 1500 });
    mr().pushChunk('abc');
    advance(500);
    await vi.advanceTimersByTimeAsync(500);
    const result = await recorder.stop();
    expect(result.durationMs).toBe(500);
    advance(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(stateLog).toEqual(['recording', 'finalizing', 'idle']);
    expect(recorder.hasPendingResult).toBe(false);
    expect(recorder.state).toBe('idle');
  });

  it('stop() during an in-flight self-finalize joins it: the result is handed out once and nothing stays pending', async () => {
    const { recorder, mr, advance } = setup();
    await recorder.start({ aspect: 'source', maxDurationMs: 1500 });
    mr().autoStop = false; // the MediaRecorder stop event is delayed
    mr().pushChunk('abc');
    advance(1500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(recorder.state).toBe('finalizing');
    expect(recorder.elapsedMs).toBe(1500); // frozen at the cap
    expect(recorder.hasPendingResult).toBe(false);
    const p = recorder.stop();
    expect(recorder.state).toBe('finalizing');
    mr().emit('stop');
    const result = await p;
    expect(result.durationMs).toBe(1500);
    expect(result.blob.size).toBe(3);
    expect(recorder.hasPendingResult).toBe(false);
    await expect(recorder.stop()).rejects.toThrow(/not recording/i);
  });

  it('a self-finalize that produced no data is reported by the next stop() once; nothing is pending', async () => {
    const { recorder, mr, advance, stateLog } = setup();
    await recorder.start({ aspect: 'source', maxDurationMs: 1000 });
    mr().autoStop = false;
    advance(1000);
    await vi.advanceTimersByTimeAsync(1000);
    mr().emit('stop'); // no chunks at all
    await vi.advanceTimersByTimeAsync(0);
    expect(stateLog).toEqual(['recording', 'finalizing', 'idle']);
    expect(recorder.hasPendingResult).toBe(false);
    await expect(recorder.stop()).rejects.toThrow(/no data/i);
    await expect(recorder.stop()).rejects.toThrow(/not recording/i);
  });

  it('a recorder error mid-recording clears the cap timer', async () => {
    const { recorder, mr, advance, stateLog } = setup();
    await recorder.start({ aspect: 'source', maxDurationMs: 1000 });
    mr().emit('error', { error: new Error('disk full') });
    expect(recorder.state).toBe('idle');
    advance(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stateLog).toEqual(['recording', 'idle']);
    expect(recorder.hasPendingResult).toBe(false);
    await expect(recorder.stop()).rejects.toThrow(/disk full/i);
  });

  it('maxDurationMs of 0 or a non-finite value disables the cap', async () => {
    for (const cap of [0, -1, Infinity, NaN]) {
      const { recorder, advance } = setup();
      await recorder.start({ aspect: 'source', maxDurationMs: cap });
      advance(2_000_000);
      await vi.advanceTimersByTimeAsync(2_000_000);
      expect(recorder.state, `cap ${cap}`).toBe('recording');
      expect(recorder.hasPendingResult).toBe(false);
      await recorder.stop();
    }
  });
});

describe('createRecorder — snapshot forwarding', () => {
  it('snapshot(aspect, opts) forwards format and quality to the snapshot encoder and uses the injected canvas factory', async () => {
    const { recorder, created } = setup(1280, 720);
    const blob = await recorder.snapshot('1:1', { format: 'jpeg', quality: 0.5 });
    expect(created).toHaveLength(1);
    expect(created[0]!.canvas.width).toBe(0); // released after encoding
    expect(created[0]!.toBlobCalls).toEqual([['image/jpeg', 0.5]]);
    expect(blob.type).toBe('image/jpeg');
  });

  it('snapshot(aspect) without options stays PNG', async () => {
    const { recorder, created } = setup(1280, 720);
    const blob = await recorder.snapshot('source');
    expect(created[0]!.toBlobCalls).toEqual([['image/png', undefined]]);
    expect(blob.type).toBe('image/png');
  });
});
