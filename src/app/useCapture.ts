/**
 * Self-timer / auto-stop / hold-still capture state machine, driven by `settings.capture`.
 *
 *  - R / S / the bar buttons: with `selfTimer > 0` a countdown is written to `session.countdown`
 *    (the HUD draws it, `CountdownBanner` announces it) and the action runs when it fires.
 *  - T: timed recording using the self-timer value (3 s when it is Off).
 *  - R / T / Esc / the Cancel button during a countdown cancel it ("Countdown cancelled").
 *  - Auto-stop: a recording started here stops after `autoStop` seconds (downloads as usual).
 *  - `session.captureRequest` (hold-still gesture, written by the runtime) is performed at once —
 *    no countdown — then cleared; `record` requests are ignored while recording/finalizing.
 *  - When the recorder stops on its own (max duration) the pending result is collected.
 *
 * `createCaptureController` is the pure core (fake-timer tested); `useActions` owns the instance.
 */
import type { AppStore, CaptureRequest, Recorder, RecorderState } from '@/types';

type CaptureAction = 'record' | 'snapshot';

export interface CaptureControllerDeps {
  store: AppStore;
  notify(message: string, kind?: 'status' | 'error'): void;
  getRecorder(): Recorder | null;
  /** Start recording immediately; resolves true when the recorder is running. */
  recordNow(): Promise<boolean>;
  /** UI stop: finalise + download. */
  stopRecording(): Promise<void>;
  snapshotNow(): Promise<void>;
  /** `recorder.stop()` for a self-finalised recording → download. */
  collectPending(): Promise<void>;
  /** Mirrors the armed auto-stop length for the recording indicator (null = none). */
  setAutoStopMs(ms: number | null): void;
  /** Clock in the performance.now() domain (countdown `endsAt`). */
  now?(): number;
}

export interface CaptureController {
  /** R / Record button: cancel a countdown, stop a recording, or start one (after the self-timer). */
  requestRecord(): void;
  /** S / Snapshot button: cancel a countdown or take a snapshot (after the self-timer). */
  requestSnapshot(): void;
  /** T. */
  timedRecord(): void;
  /** Returns true when a countdown was running (and is now cancelled). */
  cancelCountdown(): boolean;
  /** UI stop (marks the stop as user-initiated so no pending result is collected twice). */
  stopRecording(): Promise<void>;
  readonly countdownActive: boolean;
  dispose(): void;
}

export function createCaptureController(deps: CaptureControllerDeps): CaptureController {
  const now = deps.now ?? (() => performance.now());
  let countdownTimer: ReturnType<typeof setTimeout> | null = null;
  let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  let uiStopping = false;
  let disposed = false;
  let lastRequestId: number | null = null;

  const state = () => deps.store.getState();
  const recorderState = (): RecorderState => deps.getRecorder()?.state ?? state().recorderState;

  /** Clears a running countdown (timer + session). Returns whether one was running. */
  function clearCountdown(): boolean {
    const had = countdownTimer !== null || state().countdown !== null;
    if (countdownTimer !== null) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
    if (state().countdown !== null) state().setSession({ countdown: null });
    return had;
  }

  function disarmAutoStop(): void {
    if (autoStopTimer !== null) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
    deps.setAutoStopMs(null);
  }

  async function stopRecording(): Promise<void> {
    uiStopping = true;
    disarmAutoStop();
    try {
      await deps.stopRecording();
    } finally {
      uiStopping = false;
    }
  }

  async function perform(action: CaptureAction): Promise<void> {
    if (action === 'snapshot') {
      await deps.snapshotNow();
      return;
    }
    if (recorderState() !== 'idle') return;
    const ok = await deps.recordNow();
    if (!ok || disposed) return;
    const seconds = state().capture.autoStop;
    if (seconds > 0) {
      const ms = seconds * 1000;
      deps.setAutoStopMs(ms);
      autoStopTimer = setTimeout(() => {
        autoStopTimer = null;
        if (recorderState() === 'recording') void stopRecording();
        else disarmAutoStop();
      }, ms);
    }
  }

  function begin(action: CaptureAction, seconds: number): void {
    if (seconds <= 0) {
      void perform(action);
      return;
    }
    const totalMs = seconds * 1000;
    state().setSession({ countdown: { action, endsAt: now() + totalMs, totalMs } });
    countdownTimer = setTimeout(() => {
      countdownTimer = null;
      state().setSession({ countdown: null });
      void perform(action);
    }, totalMs);
  }

  /** Cancels a countdown with the user-facing toast; true when one was running. */
  function cancelWithToast(): boolean {
    if (!clearCountdown()) return false;
    deps.notify('Countdown cancelled');
    return true;
  }

  function onCaptureRequest(req: CaptureRequest): void {
    lastRequestId = req.id;
    clearCountdown();
    if (req.action === 'snapshot') void perform('snapshot');
    else if (recorderState() === 'idle') void perform('record');
    state().setSession({ captureRequest: null });
  }

  const unsubscribe = deps.store.subscribe((s, prev) => {
    if (disposed) return;
    if (s.captureRequest && s.captureRequest !== prev.captureRequest && s.captureRequest.id !== lastRequestId) {
      onCaptureRequest(s.captureRequest);
    }
    if (s.recorderState !== prev.recorderState && s.recorderState !== 'recording') {
      // The recording ended by any means: drop the auto-stop; collect a self-finalised result.
      if (autoStopTimer !== null) disarmAutoStop();
      const rec = deps.getRecorder();
      if (!uiStopping && rec && rec.hasPendingResult === true) void deps.collectPending();
    }
  });

  return {
    requestRecord() {
      if (cancelWithToast()) return;
      const rs = recorderState();
      if (rs === 'recording') {
        void stopRecording();
        return;
      }
      if (rs === 'finalizing') return;
      begin('record', state().capture.selfTimer);
    },
    requestSnapshot() {
      if (cancelWithToast()) return;
      begin('snapshot', state().capture.selfTimer);
    },
    timedRecord() {
      if (cancelWithToast()) return;
      const rs = recorderState();
      if (rs === 'recording') {
        void stopRecording();
        return;
      }
      if (rs === 'finalizing') return;
      begin('record', state().capture.selfTimer || 3);
    },
    cancelCountdown: cancelWithToast,
    stopRecording,
    get countdownActive() {
      return countdownTimer !== null;
    },
    dispose() {
      disposed = true;
      unsubscribe();
      clearCountdown();
      if (autoStopTimer !== null) disarmAutoStop();
    },
  };
}
