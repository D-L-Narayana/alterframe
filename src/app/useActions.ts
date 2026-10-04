/**
 * The one set of user-facing actions shared by the ControlsBar, the mobile controls sheet and the
 * keyboard shortcuts. Recording/snapshot go through the real `RuntimeHandle` held in `handleRef`;
 * the self-timer / auto-stop / hold-still logic lives in the capture controller (`useCapture.ts`);
 * file playback keys read the live source's `transport` through `sourceRef`.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type { BaseStyle, FrameSource, PersonaId, RuntimeHandle } from '@/types';
import { useAppStore } from '@/state/store';
import { useUiStore } from '@/state/uiStore';
import { captureFilename, downloadBlob } from './format';
import { resolveEscape, type ShortcutActions } from './shortcuts';
import { createTransportActions } from './transportActions';
import { createCaptureController, type CaptureController } from './useCapture';

const PERSONA_LABEL: Record<PersonaId, string> = { portrait: 'Portrait', masked: 'Masked hero', suit: 'Web suit' };
const BASE_LABEL: Record<BaseStyle, string> = { live: 'Live', comic: 'Comic' };

export interface AppActions extends ShortcutActions {
  setBase(b: BaseStyle): void;
  cyclePersona(): void;
  setHud(v: boolean): void;
  /** Immediate start (no self-timer). */
  startRecording(): Promise<void>;
  /** Stop + download (user-initiated). */
  stopRecording(): Promise<void>;
  cancelCountdown(): void;
  retryTracker(): void;
  continueWithoutTracking(): void;
  openSettings(): void;
  closePanels(): void;
}

/** Immediate capture operations the controller sequences (timers, gesture requests). */
interface CapturePrimitives {
  recordNow(): Promise<boolean>;
  stopRecording(): Promise<void>;
  snapshotNow(): Promise<void>;
  collectPending(): Promise<void>;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Unknown error');

export function useActions(handleRef: RefObject<RuntimeHandle | null>, sourceRef?: RefObject<FrameSource | null>): AppActions {
  // Keep the recorder's elapsed time mirrored into the session while recording.
  const recorderState = useAppStore((s) => s.recorderState);
  useEffect(() => {
    if (recorderState !== 'recording') return;
    const id = window.setInterval(() => {
      const h = handleRef.current;
      if (h) useAppStore.getState().setSession({ recorderElapsedMs: h.recorder.elapsedMs });
    }, 250);
    return () => window.clearInterval(id);
  }, [recorderState, handleRef]);

  const controllerRef = useRef<CaptureController | null>(null);

  const { actions, primitives } = useMemo(() => {
    const app = () => useAppStore.getState();
    const ui = () => useUiStore.getState();
    const controller = () => controllerRef.current;

    const requireHandle = (): RuntimeHandle | null => {
      const h = handleRef.current;
      if (!h) ui().notify('Start the camera or open a video first.', 'error');
      return h;
    };

    const primitives: CapturePrimitives = {
      async recordNow() {
        const h = requireHandle();
        if (!h || h.recorder.state !== 'idle') return false;
        try {
          await h.recorder.start({ aspect: app().capture.aspect });
          app().setSession({ recorderState: 'recording', recorderElapsedMs: 0 });
          ui().notify('Recording started');
          return true;
        } catch (err) {
          app().setSession({ recorderState: 'idle', recorderElapsedMs: 0 });
          ui().notify(`Recording failed: ${errorMessage(err)}`, 'error');
          return false;
        }
      },
      async stopRecording() {
        const h = handleRef.current;
        if (!h || h.recorder.state !== 'recording') return;
        app().setSession({ recorderState: 'finalizing' });
        try {
          const { blob, mime } = await h.recorder.stop();
          downloadBlob(blob, captureFilename(mime));
          ui().notify('Recording saved to your downloads');
        } catch (err) {
          ui().notify(`Could not save recording: ${errorMessage(err)}`, 'error');
        } finally {
          app().setSession({ recorderState: 'idle', recorderElapsedMs: 0 });
        }
      },
      async snapshotNow() {
        const h = requireHandle();
        if (!h) return;
        try {
          const blob = await h.snapshot(app().capture.aspect, { format: app().capture.snapshotFormat });
          // Extension from the encoder's actual output (browsers fall back to PNG for unsupported types).
          downloadBlob(blob, captureFilename(blob.type || 'image/png'));
          ui().notify('Snapshot saved');
        } catch (err) {
          ui().notify(`Snapshot failed: ${errorMessage(err)}`, 'error');
        }
      },
      async collectPending() {
        const h = handleRef.current;
        if (!h) return;
        try {
          const { blob, mime } = await h.recorder.stop();
          if (blob.size > 0) {
            downloadBlob(blob, captureFilename(mime));
            ui().notify('Recording reached its maximum length and was saved to your downloads');
          }
        } catch (err) {
          ui().notify(`Could not save recording: ${errorMessage(err)}`, 'error');
        } finally {
          app().setSession({ recorderState: 'idle', recorderElapsedMs: 0 });
        }
      },
    };

    // Built at event time (never during render): the live source's transport is read through the ref then.
    const transport = () =>
      createTransportActions({
        getTransport: () => sourceRef?.current?.transport ?? null,
        notify: (message, kind) => ui().notify(message, kind),
      });

    const actions: AppActions = {
      setPersona(p) {
        app().setScene({ persona: p });
        ui().notify(`Persona: ${PERSONA_LABEL[p]}`);
      },
      cyclePersona() {
        app().cyclePersona();
        ui().notify(`Persona: ${PERSONA_LABEL[app().scene.persona]}`);
      },
      setBase(b) {
        app().setScene({ base: b });
        ui().notify(`Base: ${BASE_LABEL[b]}`);
      },
      toggleBase() {
        actions.setBase(app().scene.base === 'live' ? 'comic' : 'live');
      },
      setHud(v) {
        app().setSettings({ hudEnabled: v });
        ui().notify(v ? 'HUD on' : 'HUD off');
      },
      toggleHud() {
        actions.setHud(!app().hudEnabled);
      },
      async startRecording() {
        await primitives.recordNow();
      },
      stopRecording() {
        return controller()?.stopRecording() ?? primitives.stopRecording();
      },
      toggleRecord() {
        const c = controller();
        if (c) {
          c.requestRecord();
          return;
        }
        if (app().recorderState === 'recording') void primitives.stopRecording();
        else if (app().recorderState === 'idle') void primitives.recordNow();
      },
      timedRecord() {
        controller()?.timedRecord();
      },
      snapshot() {
        const c = controller();
        if (c) c.requestSnapshot();
        else void primitives.snapshotNow();
      },
      cancelCountdown() {
        controller()?.cancelCountdown();
      },
      toggleDirector() {
        const next = !app().directorRunning;
        app().setDirectorRunning(next);
        ui().notify(next ? 'Director playing the reel sequence' : 'Director stopped');
      },
      toggleMirror() {
        const next = !app().mirrored;
        app().setSettings({ mirrored: next });
        ui().notify(next ? 'Mirror on' : 'Mirror off');
      },
      toggleFps() {
        app().setSettings({ showFps: !app().showFps });
      },
      togglePlayback() {
        transport().togglePlayback();
      },
      seekBy(deltaSeconds) {
        transport().seekBy(deltaSeconds);
      },
      toggleLoop() {
        transport().toggleLoop();
      },
      retryTracker() {
        // Optional handle method: absent → nothing to do (the card simply stays).
        void handleRef.current?.retryTracker?.();
      },
      continueWithoutTracking() {
        ui().dismissTrackerFailure();
      },
      toggleHelp() {
        ui().togglePanel('help');
      },
      openSettings() {
        ui().openPanel('settings');
      },
      closePanels() {
        ui().closePanel();
      },
      escape() {
        const c = controller();
        const h = handleRef.current;
        const target = resolveEscape({
          countdownActive: c?.countdownActive ?? false,
          panelOpen: ui().panel !== null,
          recording: h?.recorder.state === 'recording' || app().recorderState === 'recording',
        });
        if (target === 'cancel-countdown') c?.cancelCountdown();
        else if (target === 'close-panel') ui().closePanel();
        else if (target === 'stop-recording') void actions.stopRecording();
      },
    };
    return { actions, primitives };
  }, [handleRef, sourceRef]);

  // The capture controller subscribes to the store (gesture requests, recorder state) → lives in an effect.
  useEffect(() => {
    const c = createCaptureController({
      store: useAppStore,
      notify: (message, kind) => useUiStore.getState().notify(message, kind),
      getRecorder: () => handleRef.current?.recorder ?? null,
      recordNow: primitives.recordNow,
      stopRecording: primitives.stopRecording,
      snapshotNow: primitives.snapshotNow,
      collectPending: primitives.collectPending,
      setAutoStopMs: (ms) => useUiStore.getState().setAutoStopMs(ms),
    });
    controllerRef.current = c;
    return () => {
      c.dispose();
      controllerRef.current = null;
    };
  }, [primitives, handleRef]);

  return actions;
}
