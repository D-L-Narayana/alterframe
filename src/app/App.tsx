/**
 * App shell. Routes on `sourceStatus`:
 *   idle                          → Onboarding
 *   requesting | ready            → Stage + notices + ControlsBar (+ model-loading progressbar until trackerReady)
 *   denied | unavailable | error  → Stage + ErrorPanel (retry / file fallback / back)
 * Settings sheet, help dialog and the status toast are global. The tracker failure card, coach hint,
 * self-timer countdown and file transport live on the stage route.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FrameSource, RuntimeDiagnostics, RuntimeHandle } from '@/types';
import { useAppStore } from '@/state/store';
import { useUiStore } from '@/state/uiStore';
import { CoachHintHost } from './CoachHint';
import { ControlsBar } from './ControlsBar';
import { CountdownBanner } from './CountdownBanner';
import { ErrorPanel } from './ErrorPanel';
import { HelpDialog } from './HelpDialog';
import { Onboarding } from './Onboarding';
import { SettingsSheet } from './SettingsSheet';
import { StatusToast } from './StatusToast';
import { Stage } from './Stage';
import { TrackerFailureCard } from './TrackerFailureCard';
import { Transport } from './Transport';
import { installContextLostToasts } from './contextLostToasts';
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
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const setSession = useAppStore((s) => s.setSession);
  const panel = useUiStore((s) => s.panel);
  const closePanel = useUiStore((s) => s.closePanel);

  const handleRef = useRef<RuntimeHandle | null>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const [spec, setSpec] = useState<SourceSpec | null>(null);
  const [attempt, setAttempt] = useState(0);
  const actions = useActions(handleRef, sourceRef);

  // Reduced motion: system preference seeds the setting; the setting drives the CSS tokens.
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = reducedMotion ? 'true' : 'false';
  }, [reducedMotion]);

  useEffect(() => installShortcuts(() => actions), [actions]);
  useEffect(() => installContextLostToasts(useAppStore, (message, kind) => useUiStore.getState().notify(message, kind)), []);

  /** Read on demand by the Diagnostics group (2 Hz while the sheet is open); null without a runtime. */
  const getDiagnostics = useCallback((): RuntimeDiagnostics | null => handleRef.current?.getDiagnostics?.() ?? null, []);

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

  const back = useCallback(async () => {
    // A recording in progress is finalised and downloaded before the stage unmounts.
    await actions.stopRecording();
    setSpec(null);
    setSession({ sourceStatus: 'idle', sourceError: null });
  }, [actions, setSession]);

  const panels = (
    <>
      <HelpDialog open={panel === 'help'} onClose={closePanel} onEscape={actions.escape} />
      <SettingsSheet open={panel === 'settings'} onClose={closePanel} onEscape={actions.escape} getDiagnostics={getDiagnostics} />
      <StatusToast />
    </>
  );

  if (sourceStatus === 'idle' || spec === null) {
    return (
      <div className="af-app">
        <Onboarding onUseCamera={useCamera} onOpenFile={openFile} cameraSupported={cameraSupported()} />
        {panels}
      </div>
    );
  }

  const failed = sourceStatus === 'denied' || sourceStatus === 'unavailable' || sourceStatus === 'error';
  return (
    <div className="af-app">
      <a href="#af-controls-anchor" className="af-skip-link">Skip to controls</a>
      <LiveStage handleRef={handleRef} sourceRef={sourceRef} spec={spec} attempt={attempt} actions={actions} />
      {failed ? (
        <ErrorPanel status={sourceStatus} message={sourceError} onRetry={retry} onOpenFile={openFile} onBack={() => void back()} />
      ) : null}
      {panels}
    </div>
  );
}

interface LiveStageProps {
  handleRef: React.RefObject<RuntimeHandle | null>;
  sourceRef: React.RefObject<FrameSource | null>;
  spec: SourceSpec;
  attempt: number;
  actions: ReturnType<typeof useActions>;
}

/** Owns the canvas + runtime lifecycle; separate component so the hook only runs on the stage route. */
function LiveStage({ handleRef, sourceRef, spec, attempt, actions }: LiveStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { switchSource, getTransport } = useRuntime(canvasRef, handleRef, sourceRef, spec, attempt);
  const { devices } = useCameraDevices(spec.kind === 'camera');
  const cameraDeviceId = useAppStore((s) => s.cameraDeviceId);
  const setSession = useAppStore((s) => s.setSession);
  const sourceStatus = useAppStore((s) => s.sourceStatus);
  const trackerReady = useAppStore((s) => s.trackerReady);
  const trackerError = useAppStore((s) => s.trackerError);
  const transportState = useAppStore((s) => s.transport);
  const trackerFailureDismissed = useUiStore((s) => s.trackerFailureDismissed);

  const live = sourceStatus === 'requesting' || sourceStatus === 'ready';
  // The download starts with the runtime, so progress is visible during the permission prompt too.
  const loading = live && !trackerReady && trackerError === null;

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
      {live && trackerError !== null && !trackerFailureDismissed ? (
        <TrackerFailureCard message={trackerError} onRetry={actions.retryTracker} onContinue={actions.continueWithoutTracking} />
      ) : null}
      <div className="af-notices">
        <CountdownBanner onCancel={actions.cancelCountdown} />
        <CoachHintHost />
        {transportState && sourceStatus === 'ready' ? <Transport state={transportState} getTransport={getTransport} /> : null}
      </div>
      <span id="af-controls-anchor" tabIndex={-1} className="af-visually-hidden" />
      <ControlsBar actions={actions} onSwitchCamera={onSwitchCamera} />
    </>
  );
}
