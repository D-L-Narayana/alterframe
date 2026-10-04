/**
 * Self-timer / auto-stop / hold-still capture state machine (fake timers, injected clock).
 * Drives `createCaptureController` — the pure core behind `useCapture` — against a real app store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CaptureSettings, Recorder, RecorderState } from '@/types';
import { DEFAULT_CAPTURE_SETTINGS } from '@/types';
import { createAppStore } from '@/state/store';
import { createCaptureController, type CaptureControllerDeps } from '@/app/useCapture';

type FakeRecorder = Recorder & { state: RecorderState; hasPendingResult: boolean };

function setup(capture: Partial<CaptureSettings> = {}, recorderState: RecorderState = 'idle') {
  const store = createAppStore();
  store.getState().setSettings({ capture: { ...DEFAULT_CAPTURE_SETTINGS, ...capture } });
  const recorder: FakeRecorder = {
    state: recorderState,
    hasPendingResult: false,
    elapsedMs: 0,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ blob: new Blob(), mime: 'video/webm', durationMs: 0 })),
    snapshot: vi.fn(async () => new Blob()),
  };
  if (recorderState !== 'idle') store.getState().setSession({ recorderState });
  let t = 1000;
  const deps: CaptureControllerDeps = {
    store,
    notify: vi.fn(),
    getRecorder: () => recorder,
    recordNow: vi.fn(async () => {
      recorder.state = 'recording';
      store.getState().setSession({ recorderState: 'recording', recorderElapsedMs: 0 });
      return true;
    }),
    stopRecording: vi.fn(async () => {
      recorder.state = 'idle';
      store.getState().setSession({ recorderState: 'idle', recorderElapsedMs: 0 });
    }),
    snapshotNow: vi.fn(async () => {}),
    collectPending: vi.fn(async () => {}),
    setAutoStopMs: vi.fn(),
    now: () => t,
  };
  const c = createCaptureController(deps);
  const advance = async (ms: number) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { store, recorder, deps, c, advance, flush };
}

describe('capture controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('R with a self-timer writes session.countdown and starts recording when it fires', async () => {
    const { store, deps, c, advance } = setup({ selfTimer: 3 });
    c.requestRecord();
    expect(store.getState().countdown).toEqual({ action: 'record', endsAt: 4000, totalMs: 3000 });
    expect(c.countdownActive).toBe(true);
    await advance(2999);
    expect(deps.recordNow).not.toHaveBeenCalled();
    await advance(1);
    expect(store.getState().countdown).toBeNull();
    expect(deps.recordNow).toHaveBeenCalledTimes(1);
    expect(c.countdownActive).toBe(false);
  });

  it('R again during the countdown cancels it with a toast and nothing starts', async () => {
    const { store, deps, c, advance } = setup({ selfTimer: 5 });
    c.requestRecord();
    c.requestRecord();
    expect(store.getState().countdown).toBeNull();
    expect(deps.notify).toHaveBeenCalledWith('Countdown cancelled');
    expect(c.cancelCountdown()).toBe(false);
    await advance(10_000);
    expect(deps.recordNow).not.toHaveBeenCalled();
  });

  it('cancelCountdown() (Esc) clears the countdown and reports whether one was running', async () => {
    const { store, deps, c, advance } = setup({ selfTimer: 3 });
    expect(c.cancelCountdown()).toBe(false);
    c.requestSnapshot();
    expect(store.getState().countdown?.action).toBe('snapshot');
    expect(c.cancelCountdown()).toBe(true);
    expect(store.getState().countdown).toBeNull();
    await advance(5000);
    expect(deps.snapshotNow).not.toHaveBeenCalled();
  });

  it('T is a timed recording: 3 s when the self-timer is off, else the self-timer value', async () => {
    const off = setup({ selfTimer: 0 });
    off.c.timedRecord();
    expect(off.store.getState().countdown).toEqual({ action: 'record', endsAt: 4000, totalMs: 3000 });
    await off.advance(3000);
    expect(off.deps.recordNow).toHaveBeenCalledTimes(1);
    off.c.dispose();

    const ten = setup({ selfTimer: 10 });
    ten.c.timedRecord();
    expect(ten.store.getState().countdown?.totalMs).toBe(10_000);
    // T again cancels.
    ten.c.timedRecord();
    expect(ten.store.getState().countdown).toBeNull();
    expect(ten.deps.notify).toHaveBeenCalledWith('Countdown cancelled');
  });

  it('S with a self-timer counts a snapshot down; without one R and S act immediately', async () => {
    const timed = setup({ selfTimer: 3 });
    timed.c.requestSnapshot();
    expect(timed.store.getState().countdown).toEqual({ action: 'snapshot', endsAt: 4000, totalMs: 3000 });
    await timed.advance(3000);
    expect(timed.deps.snapshotNow).toHaveBeenCalledTimes(1);
    timed.c.dispose();

    const direct = setup({ selfTimer: 0 });
    direct.c.requestSnapshot();
    direct.c.requestRecord();
    await direct.flush();
    expect(direct.store.getState().countdown).toBeNull();
    expect(direct.deps.snapshotNow).toHaveBeenCalledTimes(1);
    expect(direct.deps.recordNow).toHaveBeenCalledTimes(1);
  });

  it('R while recording stops it (through the UI stop, so no pending-result collection)', async () => {
    const { deps, c, flush } = setup({ selfTimer: 3 });
    c.requestRecord();
    await flush();
    // Simulate the countdown having fired earlier: force a recording in progress.
    c.cancelCountdown();
    await deps.recordNow();
    c.requestRecord();
    await flush();
    expect(deps.stopRecording).toHaveBeenCalledTimes(1);
    expect(deps.collectPending).not.toHaveBeenCalled();
  });

  it('auto-stop stops the recording after the configured length and exposes the armed length', async () => {
    const { deps, c, advance, flush } = setup({ autoStop: 10 });
    c.requestRecord();
    await flush();
    expect(deps.recordNow).toHaveBeenCalledTimes(1);
    expect(deps.setAutoStopMs).toHaveBeenLastCalledWith(10_000);
    await advance(9_999);
    expect(deps.stopRecording).not.toHaveBeenCalled();
    await advance(1);
    expect(deps.stopRecording).toHaveBeenCalledTimes(1);
    expect(deps.setAutoStopMs).toHaveBeenLastCalledWith(null);
  });

  it('a manual stop disarms auto-stop', async () => {
    const { deps, c, advance, flush } = setup({ autoStop: 10 });
    c.requestRecord();
    await flush();
    c.requestRecord(); // recording → stop
    await flush();
    expect(deps.stopRecording).toHaveBeenCalledTimes(1);
    expect(deps.setAutoStopMs).toHaveBeenLastCalledWith(null);
    await advance(20_000);
    expect(deps.stopRecording).toHaveBeenCalledTimes(1);
  });

  it('auto-stop is not armed when the setting is Off', async () => {
    const { deps, c, advance, flush } = setup({ autoStop: 0 });
    c.requestRecord();
    await flush();
    expect(deps.setAutoStopMs).not.toHaveBeenCalledWith(expect.any(Number));
    await advance(120_000);
    expect(deps.stopRecording).not.toHaveBeenCalled();
  });

  it('collects the pending result when the recorder stopped on its own (max duration)', async () => {
    const { store, recorder, deps, flush } = setup({}, 'recording');
    recorder.state = 'idle';
    recorder.hasPendingResult = true;
    store.getState().setSession({ recorderState: 'idle' });
    await flush();
    expect(deps.collectPending).toHaveBeenCalledTimes(1);
  });

  it('does not collect when recording ended without a pending result', async () => {
    const { store, recorder, deps, flush } = setup({}, 'recording');
    recorder.state = 'idle';
    recorder.hasPendingResult = false;
    store.getState().setSession({ recorderState: 'idle' });
    await flush();
    expect(deps.collectPending).not.toHaveBeenCalled();
  });

  it('consumes hold-still capture requests immediately (no countdown) and clears them', async () => {
    const { store, deps, flush } = setup({ selfTimer: 5 });
    store.getState().setSession({ captureRequest: { action: 'snapshot', id: 1, source: 'dwell' } });
    await flush();
    expect(deps.snapshotNow).toHaveBeenCalledTimes(1);
    expect(store.getState().countdown).toBeNull();
    expect(store.getState().captureRequest).toBeNull();

    store.getState().setSession({ captureRequest: { action: 'record', id: 2, source: 'dwell' } });
    await flush();
    expect(deps.recordNow).toHaveBeenCalledTimes(1);
    expect(store.getState().captureRequest).toBeNull();
  });

  it('ignores record requests while recording or finalizing (but still clears them)', async () => {
    const { store, recorder, deps, flush } = setup({}, 'recording');
    store.getState().setSession({ captureRequest: { action: 'record', id: 7, source: 'dwell' } });
    await flush();
    expect(deps.recordNow).not.toHaveBeenCalled();
    expect(store.getState().captureRequest).toBeNull();

    recorder.state = 'finalizing';
    store.getState().setSession({ recorderState: 'finalizing', captureRequest: { action: 'record', id: 8, source: 'dwell' } });
    await flush();
    expect(deps.recordNow).not.toHaveBeenCalled();
    expect(store.getState().captureRequest).toBeNull();
  });

  it('a gesture request supersedes a running self-timer', async () => {
    const { store, deps, c, advance, flush } = setup({ selfTimer: 5 });
    c.requestRecord();
    store.getState().setSession({ captureRequest: { action: 'snapshot', id: 3, source: 'dwell' } });
    await flush();
    expect(store.getState().countdown).toBeNull();
    expect(deps.snapshotNow).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(deps.recordNow).not.toHaveBeenCalled();
  });

  it('dispose clears the countdown, timers and subscriptions', async () => {
    const { store, deps, c, advance } = setup({ selfTimer: 3, autoStop: 10 });
    c.requestRecord();
    c.dispose();
    expect(store.getState().countdown).toBeNull();
    await advance(5000);
    expect(deps.recordNow).not.toHaveBeenCalled();
    store.getState().setSession({ captureRequest: { action: 'snapshot', id: 9, source: 'dwell' } });
    await advance(0);
    expect(deps.snapshotNow).not.toHaveBeenCalled();
  });
});
