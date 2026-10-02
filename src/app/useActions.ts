/**
 * The one set of user-facing actions shared by the ControlsBar, the mobile controls sheet
 * and the keyboard shortcuts (W1). Recording/snapshot go through the real `RuntimeHandle`
 * held in `handleRef`.
 */
import { useEffect, useMemo, type RefObject } from 'react';
import type { BaseStyle, PersonaId, RuntimeHandle } from '@/types';
import { useAppStore } from '@/state/store';
import { useUiStore } from '@/state/uiStore';
import { captureFilename, downloadBlob } from './format';
import type { ShortcutActions } from './shortcuts';

const PERSONA_LABEL: Record<PersonaId, string> = { portrait: 'Portrait', masked: 'Masked hero', suit: 'Web suit' };
const BASE_LABEL: Record<BaseStyle, string> = { live: 'Live', comic: 'Comic' };

export interface AppActions extends ShortcutActions {
  setBase(b: BaseStyle): void;
  cyclePersona(): void;
  setHud(v: boolean): void;
  startRecording(): Promise<void>;
  stopRecording(): Promise<void>;
  openSettings(): void;
  closePanels(): void;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Unknown error');

export function useActions(handleRef: RefObject<RuntimeHandle | null>): AppActions {
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

  return useMemo<AppActions>(() => {
    const app = () => useAppStore.getState();
    const ui = () => useUiStore.getState();

    const requireHandle = (): RuntimeHandle | null => {
      const h = handleRef.current;
      if (!h) ui().notify('Start the camera or open a video first.', 'error');
      return h;
    };

    const startRecording = async () => {
      const h = requireHandle();
      if (!h || app().recorderState !== 'idle') return;
      try {
        await h.recorder.start({ aspect: ui().captureAspect });
        app().setSession({ recorderState: 'recording', recorderElapsedMs: 0 });
        ui().notify('Recording started');
      } catch (err) {
        app().setSession({ recorderState: 'idle', recorderElapsedMs: 0 });
        ui().notify(`Recording failed: ${errorMessage(err)}`, 'error');
      }
    };

    const stopRecording = async () => {
      const h = handleRef.current;
      if (!h || app().recorderState !== 'recording') return;
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
    };

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
      startRecording,
      stopRecording,
      toggleRecord() {
        if (app().recorderState === 'recording') void stopRecording();
        else if (app().recorderState === 'idle') void startRecording();
      },
      snapshot() {
        const h = requireHandle();
        if (!h) return;
        h.snapshot(ui().captureAspect)
          .then((blob) => {
            downloadBlob(blob, captureFilename('png'));
            ui().notify('Snapshot saved');
          })
          .catch((err: unknown) => ui().notify(`Snapshot failed: ${errorMessage(err)}`, 'error'));
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
        if (ui().panel) {
          ui().closePanel();
        } else if (app().recorderState === 'recording') {
          void stopRecording();
        }
      },
    };
    return actions;
  }, [handleRef]);
}
