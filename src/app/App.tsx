/**
 * App shell (W1). Routes on `sourceStatus`:
 *   idle                          → Onboarding
 *   requesting | ready            → Stage + ControlsBar (+ loading bar until trackerReady)
 *   denied | unavailable | error  → Stage + ErrorPanel (retry / file fallback / back)
 * Settings sheet, help dialog and the status toast are global.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeHandle } from '@/types';
import { useAppStore } from '@/state/store';
import { useUiStore } from '@/state/uiStore';
import { ControlsBar } from './ControlsBar';
import { ErrorPanel } from './ErrorPanel';
import { HelpDialog } from './HelpDialog';
import { Onboarding } from './Onboarding';
import { SettingsSheet } from './SettingsSheet';
import { StatusToast } from './StatusToast';
import { Stage } from './Stage';
import { installShortcuts } from './shortcuts';
import type { SourceSpec } from './sourceSpec';
import { useActions } from './useActions';
import { useCameraDevices } from './useCameraDevices';
import { useRuntime } from './useRuntime';
import '@/styles/global.css';
import '@/ui/ui.css';
import './app.css';

const cameraSupported = () =>
  typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices) && typeof navigator.mediaDevices.getUserMedia === 'function';

export function App() {
  const sourceStatus = useAppStore((s) => s.sourceStatus);
  const sourceError = useAppStore((s) => s.sourceError);
  const trackerReady = useAppStore((s) => s.trackerReady);
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const setSession = useAppStore((s) => s.setSession);
  const panel = useUiStore((s) => s.panel);
  const closePanel = useUiStore((s) => s.closePanel);

  const handleRef = useRef<RuntimeHandle | null>(null);
  const [spec, setSpec] = useState<SourceSpec | null>(null);
  const [attempt, setAttempt] = useState(0);
  const actions = useActions(handleRef);

  // Reduced motion: system preference seeds the setting; the setting drives the CSS tokens.
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = reducedMotion ? 'true' : 'false';
  }, [reducedMotion]);

  useEffect(() => installShortcuts(() => actions), [actions]);

  const useCamera = useCallback((deviceId: string | null) => {
    setSpec({ kind: 'camera', deviceId, facingMode: useUiStore.getState().facingMode });
    setSession({ sourceKind: 'camera', sourceStatus: 'requesting', sourceError: null, cameraDeviceId: deviceId });
  }, [setSession]);

  const openFile = useCallback((file: File) => {
    setSpec({ kind: 'file', file });
    setSession({ sourceKind: 'file', sourceStatus: 'requesting', sourceError: null });
    useUiStore.getState().notify(`Opened ${file.name}`);
  }, [setSession]);

  const retry = useCallback(() => {
    setSession({ sourceStatus: 'requesting', sourceError: null });
    setAttempt((n) => n + 1);
  }, [setSession]);

  const back = useCallback(() => {
    setSpec(null);
    setSession({ sourceStatus: 'idle', sourceError: null });
  }, [setSession]);

  if (sourceStatus === 'idle' || spec === null) {
    return (
      <div className="af-app">
        <Onboarding onUseCamera={useCamera} onOpenFile={openFile} cameraSupported={cameraSupported()} />
        <HelpDialog open={panel === 'help'} onClose={closePanel} />
        <SettingsSheet open={panel === 'settings'} onClose={closePanel} />
        <StatusToast />
      </div>
    );
  }

  const failed = sourceStatus === 'denied' || sourceStatus === 'unavailable' || sourceStatus === 'error';
  return (
    <div className="af-app">
      <a href="#af-controls-anchor" className="af-skip-link">Skip to controls</a>
      <LiveStage handleRef={handleRef} spec={spec} attempt={attempt} loading={sourceStatus === 'ready' && !trackerReady} actions={actions} />
      {failed ? (
        <ErrorPanel status={sourceStatus} message={sourceError} onRetry={retry} onOpenFile={openFile} onBack={back} />
      ) : null}
      <HelpDialog open={panel === 'help'} onClose={closePanel} />
      <SettingsSheet open={panel === 'settings'} onClose={closePanel} />
      <StatusToast />
    </div>
  );
}

interface LiveStageProps {
  handleRef: React.RefObject<RuntimeHandle | null>;
  spec: SourceSpec;
  attempt: number;
  loading: boolean;
  actions: ReturnType<typeof useActions>;
}

/** Owns the canvas + runtime lifecycle; separate component so the hook only runs on the stage route. */
function LiveStage({ handleRef, spec, attempt, loading, actions }: LiveStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { switchSource } = useRuntime(canvasRef, handleRef, spec, attempt);
  const { devices } = useCameraDevices(spec.kind === 'camera');
  const cameraDeviceId = useAppStore((s) => s.cameraDeviceId);
  const setSession = useAppStore((s) => s.setSession);

  const onSwitchCamera = useMemo(() => {
    if (spec.kind !== 'camera') return null;
    const ui = useUiStore.getState();
    if (devices.length > 1) {
      return () => {
        const i = Math.max(0, devices.findIndex((d) => d.deviceId === cameraDeviceId));
        const next = devices[(i + 1) % devices.length];
        if (!next) return;
        setSession({ cameraDeviceId: next.deviceId });
        void switchSource({ kind: 'camera', deviceId: next.deviceId, facingMode: ui.facingMode });
        ui.notify(`Camera: ${next.label || `Camera ${((i + 1) % devices.length) + 1}`}`);
      };
    }
    // Single enumerated device (common on mobile before permission): toggle facing mode.
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    if (!coarse) return null;
    return () => {
      const facing = useUiStore.getState().facingMode === 'user' ? 'environment' : 'user';
      useUiStore.getState().setFacingMode(facing);
      void switchSource({ kind: 'camera', deviceId: null, facingMode: facing });
      useUiStore.getState().notify(facing === 'user' ? 'Front camera' : 'Rear camera');
    };
  }, [spec.kind, devices, cameraDeviceId, setSession, switchSource]);

  return (
    <>
      <Stage ref={canvasRef} loading={loading} />
      <span id="af-controls-anchor" tabIndex={-1} className="af-visually-hidden" />
      <ControlsBar actions={actions} onSwitchCamera={onSwitchCamera} />
    </>
  );
}
