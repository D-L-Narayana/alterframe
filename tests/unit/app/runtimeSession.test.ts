/**
 * Runtime session lifecycle (pure parts of useRuntime): the runtime starts BEFORE the source has
 * started (model download overlaps the camera permission prompt), source failures keep their precise
 * classification, and a live recording is preserved (stopped + downloaded) before the runtime stops.
 */
import { describe, it, expect, vi } from 'vitest';
import type { FrameSource, Recorder, RecorderState, RuntimeDeps, RuntimeHandle, SourceStatus } from '@/types';
import { createAppStore } from '@/state/store';
import { bootSession, teardownSession, preserveRecording } from '@/app/useRuntime';

vi.mock('@/app/runtimeBridge', () => ({ startRuntime: vi.fn(), createCameraSource: vi.fn(), createFileSource: vi.fn() }));

class FakeSource implements FrameSource {
  readonly kind = 'camera' as const;
  readonly video = {} as HTMLVideoElement;
  status: SourceStatus = 'idle';
  error: string | null = null;
  width = 0;
  height = 0;
  readonly facingMode = 'user' as const;
  stopCalls = 0;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((e: unknown) => void) | null = null;
  constructor(private readonly events: string[] = []) {}
  start(): Promise<void> {
    this.events.push('source.start');
    this.status = 'requesting';
    return new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
  }
  /** Simulates the permission prompt resolving. */
  ready(): void {
    this.status = 'ready';
    this.width = 1280;
    this.height = 720;
    this.events.push('source.ready');
    this.resolveStart?.();
  }
  fail(status: Extract<SourceStatus, 'denied' | 'unavailable' | 'error'>, err: unknown): void {
    this.status = status;
    this.error = err instanceof Error ? err.message : String(err);
    this.rejectStart?.(err);
  }
  stop(): void {
    this.stopCalls += 1;
    this.status = 'idle';
    this.events.push('source.stop');
  }
  onFrame(): () => void {
    return () => {};
  }
}

function fakeRecorder(state: RecorderState, blob: Blob, order: string[] = []): Recorder & { stopCalls: number } {
  const rec = {
    state,
    elapsedMs: 0,
    stopCalls: 0,
    async start() {
      rec.state = 'recording';
    },
    stop() {
      rec.stopCalls += 1;
      order.push('recorder.stop');
      rec.state = 'finalizing';
      return Promise.resolve({ blob, mime: 'video/webm;codecs=vp9', durationMs: 1200 }).then((r) => {
        rec.state = 'idle';
        return r;
      });
    },
    snapshot: async () => new Blob([], { type: 'image/png' }),
  };
  return rec;
}

function fakeHandle(recorder: Recorder, order: string[] = []): RuntimeHandle {
  return {
    recorder,
    stop: () => {
      order.push('handle.stop');
    },
    snapshot: (a, o) => recorder.snapshot(a, o),
    getStats: () => ({ fps: 0, frameMs: 0, trackingMs: 0, renderMs: 0 }),
    setSource: async () => {},
  };
}

const canvas = {} as HTMLCanvasElement;
const cameraSpec = { kind: 'camera', deviceId: null, facingMode: 'user' } as const;

describe('bootSession', () => {
  it('starts the runtime before the source start resolves (parallel model download)', async () => {
    const events: string[] = [];
    const source = new FakeSource(events);
    const store = createAppStore();
    const recorder = fakeRecorder('idle', new Blob());
    const handle = fakeHandle(recorder);
    let seen: RuntimeDeps | null = null;
    const boot = bootSession({
      canvas,
      store,
      spec: cameraSpec,
      createSource: () => source,
      startRuntime: (deps) => {
        events.push('startRuntime');
        seen = deps;
        return handle;
      },
    });
    expect(boot.handle).toBe(handle);
    expect(boot.source).toBe(source);
    expect(seen).not.toBeNull();
    expect((seen as unknown as RuntimeDeps).source).toBe(source);
    expect((seen as unknown as RuntimeDeps).canvas).toBe(canvas);
    expect((seen as unknown as RuntimeDeps).store).toBe(store);
    // The runtime (and with it the model download) is up while the permission prompt is still pending.
    expect(events).toEqual(['startRuntime', 'source.start']);
    expect(store.getState().sourceStatus).toBe('requesting');
    expect(store.getState().sourceKind).toBe('camera');
    source.ready();
    await boot.started;
    expect(store.getState().sourceStatus).toBe('ready');
    expect(store.getState().sourceError).toBeNull();
  });

  it('keeps the precise denied / unavailable classification from the source failure', async () => {
    for (const [status, name, re] of [
      ['denied', 'NotAllowedError', /denied/i],
      ['unavailable', 'NotFoundError', /no usable camera|not found/i],
    ] as const) {
      const source = new FakeSource();
      const store = createAppStore();
      const handle = fakeHandle(fakeRecorder('idle', new Blob()));
      const boot = bootSession({ canvas, store, spec: cameraSpec, createSource: () => source, startRuntime: () => handle });
      source.fail(status, Object.assign(new Error(`${name} (test)`), { name }));
      await boot.started;
      expect(store.getState().sourceStatus).toBe(status);
      expect(store.getState().sourceError ?? '').toMatch(re);
      // The runtime keeps running (untracked frames / file fallback can reuse it).
      expect(boot.handle).toBe(handle);
    }
  });

  it('passes a pre-classified MediaSourceError message through verbatim', async () => {
    const source = new FakeSource();
    const store = createAppStore();
    const boot = bootSession({ canvas, store, spec: cameraSpec, createSource: () => source, startRuntime: () => fakeHandle(fakeRecorder('idle', new Blob())) });
    source.fail('error', Object.assign(new Error('The camera is busy'), { status: 'error' }));
    await boot.started;
    expect(store.getState().sourceStatus).toBe('error');
    expect(store.getState().sourceError).toBe('The camera is busy');
  });

  it('maps a synchronous runtime start failure to sourceStatus error and does not start the source', async () => {
    const events: string[] = [];
    const source = new FakeSource(events);
    const store = createAppStore();
    const boot = bootSession({
      canvas,
      store,
      spec: cameraSpec,
      createSource: () => source,
      startRuntime: () => {
        throw new Error('WebGL2 unavailable');
      },
    });
    expect(boot.handle).toBeNull();
    await boot.started;
    expect(events).toEqual([]);
    expect(store.getState().sourceStatus).toBe('error');
    expect(store.getState().sourceError).toContain('WebGL2 unavailable');
  });

  it('ignores a late source result after cancel (StrictMode remount / spec change)', async () => {
    const source = new FakeSource();
    const store = createAppStore();
    const boot = bootSession({ canvas, store, spec: cameraSpec, createSource: () => source, startRuntime: () => fakeHandle(fakeRecorder('idle', new Blob())) });
    boot.cancel();
    store.getState().setSession({ sourceStatus: 'idle' });
    source.ready();
    await boot.started;
    expect(store.getState().sourceStatus).toBe('idle');
  });
});

describe('preserveRecording / teardownSession', () => {
  it('stops a live recording and downloads the blob before the runtime and source stop', async () => {
    const order: string[] = [];
    const recorder = fakeRecorder('recording', new Blob(['abc'], { type: 'video/webm' }), order);
    const handle = fakeHandle(recorder, order);
    const source = new FakeSource(order);
    const store = createAppStore();
    store.getState().setSession({ trackerReady: true, trackerProgress: 1, windowOpen: true, recorderState: 'recording', recorderElapsedMs: 1200, transport: { paused: false, currentTime: 1, duration: 2, loop: true } });
    const download = vi.fn();
    const notify = vi.fn();
    const pending = teardownSession({ handle, source, cancel: () => {} }, store, { download, notify });
    expect(order).toEqual(['recorder.stop', 'handle.stop', 'source.stop']);
    await pending;
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, name] = download.mock.calls[0] as [Blob, string];
    expect(blob.size).toBe(3);
    expect(name).toMatch(/^alterframe-\d{8}-\d{6}\.webm$/);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/saved/i), 'status');
    // Session is reset for the next source.
    const s = store.getState();
    expect(s.trackerReady).toBe(false);
    expect(s.trackerProgress).toBe(0);
    expect(s.windowOpen).toBe(false);
    expect(s.recorderState).toBe('idle');
    expect(s.recorderElapsedMs).toBe(0);
    expect(s.transport).toBeNull();
    expect(s.countdown).toBeNull();
    expect(s.captureRequest).toBeNull();
  });

  it('does not download an empty blob, and is a no-op when the recorder is idle', async () => {
    const download = vi.fn();
    const notify = vi.fn();
    const empty = fakeRecorder('recording', new Blob([], { type: 'video/webm' }));
    await preserveRecording(fakeHandle(empty), { download, notify });
    expect(empty.stopCalls).toBe(1);
    expect(download).not.toHaveBeenCalled();

    const idle = fakeRecorder('idle', new Blob(['x']));
    await preserveRecording(fakeHandle(idle), { download, notify });
    expect(idle.stopCalls).toBe(0);
    await preserveRecording(null, { download, notify });
    expect(download).not.toHaveBeenCalled();
  });

  it('reports a failed finalisation as an error toast instead of throwing', async () => {
    const recorder = fakeRecorder('recording', new Blob(['x']));
    recorder.stop = () => Promise.reject(new Error('muxer died'));
    const notify = vi.fn();
    await expect(preserveRecording(fakeHandle(recorder), { download: vi.fn(), notify })).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('muxer died'), 'error');
  });
});
