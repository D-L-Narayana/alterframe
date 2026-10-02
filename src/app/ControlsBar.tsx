import { useState } from 'react';
import type { BaseStyle, PersonaId } from '@/types';
import { useAppStore } from '@/state/store';
import { useUiStore } from '@/state/uiStore';
import {
  CameraIcon, HelpIcon, HudIcon, IconButton, MirrorIcon, MoreIcon, PlayIcon, RecordIcon, Segmented, SettingsIcon,
  Sheet, StopIcon, SwitchCameraIcon, Toggle,
} from '@/ui';
import type { AppActions } from './useActions';
import { formatElapsed } from './format';
import { useMediaQuery } from './useMediaQuery';

export const PERSONA_OPTIONS = [
  { value: 'portrait', label: 'Portrait', shortcut: '1', accent: true },
  { value: 'masked', label: 'Masked', shortcut: '2', accent: true, ariaLabel: 'Masked hero' },
  { value: 'suit', label: 'Suit', shortcut: '3', accent: true, ariaLabel: 'Web suit' },
] as const satisfies ReadonlyArray<{ value: PersonaId; label: string; shortcut: string; accent: boolean; ariaLabel?: string }>;

export const BASE_OPTIONS = [
  { value: 'live', label: 'Live', shortcut: 'B' },
  { value: 'comic', label: 'Comic', shortcut: 'B' },
] as const satisfies ReadonlyArray<{ value: BaseStyle; label: string; shortcut: string }>;

/** Red dot + mm:ss while recording (blink disabled under reduced motion via CSS tokens). */
export function RecordingIndicator({ elapsedMs }: { elapsedMs: number }) {
  const text = formatElapsed(elapsedMs);
  return (
    <span className="af-controls__rec" aria-live="off">
      <span className="af-controls__dot" aria-hidden="true" />
      <span aria-label={`Recording, ${text}`}>{text}</span>
    </span>
  );
}

export function FpsBadge({ fps }: { fps: number }) {
  const n = Math.round(fps);
  return <span className="af-badge" aria-label={`${n} frames per second`}>{n} fps</span>;
}

export interface ControlsBarProps {
  actions: AppActions;
  /** Present when the active source is a camera with an alternative to switch to. */
  onSwitchCamera: (() => void) | null;
}

export function ControlsBar({ actions, onSwitchCamera }: ControlsBarProps) {
  const compact = useMediaQuery('(max-width: 760px)');
  const scene = useAppStore((s) => s.scene);
  const hudEnabled = useAppStore((s) => s.hudEnabled);
  const mirrored = useAppStore((s) => s.mirrored);
  const showFps = useAppStore((s) => s.showFps);
  const fps = useAppStore((s) => s.fps);
  const directorRunning = useAppStore((s) => s.directorRunning);
  const recorderState = useAppStore((s) => s.recorderState);
  const elapsed = useAppStore((s) => s.recorderElapsedMs);
  const panel = useUiStore((s) => s.panel);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const [moreOpen, setMoreOpen] = useState(false);

  const recording = recorderState === 'recording';
  const finalizing = recorderState === 'finalizing';

  const sceneControls = (
    <>
      <Segmented<PersonaId> label="Persona" options={PERSONA_OPTIONS} value={scene.persona} onChange={actions.setPersona} block={compact} />
      <Segmented<BaseStyle> label="Base style" options={BASE_OPTIONS} value={scene.base} onChange={actions.setBase} block={compact} />
    </>
  );

  return (
    <>
      <nav className={['af-controls', compact && 'af-controls--compact'].filter(Boolean).join(' ')} aria-label="Stage controls">
        {!compact ? (
          <>
            <div className="af-controls__group af-controls__desktop">{sceneControls}</div>
            <span className="af-controls__sep af-controls__desktop" aria-hidden="true" />
            <div className="af-controls__group af-controls__desktop">
              <IconButton label="HUD callouts" shortcut="H" icon={<HudIcon />} pressed={hudEnabled} onClick={actions.toggleHud} />
              <IconButton label={directorRunning ? 'Stop director' : 'Play director sequence'} shortcut="D" icon={directorRunning ? <StopIcon /> : <PlayIcon />} pressed={directorRunning} onClick={actions.toggleDirector} />
              <IconButton label="Mirror" shortcut="M" icon={<MirrorIcon />} pressed={mirrored} onClick={actions.toggleMirror} />
              {onSwitchCamera ? <IconButton label="Switch camera" icon={<SwitchCameraIcon />} onClick={onSwitchCamera} /> : null}
            </div>
            <span className="af-controls__sep" aria-hidden="true" />
          </>
        ) : null}

        <div className="af-controls__group">
          <IconButton
            label={recording ? 'Stop recording' : finalizing ? 'Saving recording' : 'Start recording'}
            shortcut="R"
            icon={recording ? <StopIcon /> : <RecordIcon />}
            recording={recording}
            disabled={finalizing}
            onClick={actions.toggleRecord}
          />
          {recording ? <RecordingIndicator elapsedMs={elapsed} /> : null}
          <IconButton label="Snapshot" shortcut="S" icon={<CameraIcon />} onClick={actions.snapshot} />
        </div>

        {showFps ? <FpsBadge fps={fps} /> : null}

        <span className="af-controls__sep" aria-hidden="true" />
        <div className="af-controls__group">
          {compact ? (
            <IconButton label="More controls" icon={<MoreIcon />} pressed={moreOpen} onClick={() => setMoreOpen(true)} />
          ) : null}
          <IconButton label="Settings" icon={<SettingsIcon />} pressed={panel === 'settings'} onClick={() => togglePanel('settings')} />
          <IconButton label="Help" shortcut="?" icon={<HelpIcon />} pressed={panel === 'help'} onClick={() => togglePanel('help')} />
        </div>
      </nav>

      {compact ? (
        <Sheet open={moreOpen} title="Controls" onClose={() => setMoreOpen(false)}>
          <div className="af-controls__sheet-body">
            {sceneControls}
            <Toggle label="HUD callouts" hint="Tracking-style codes at the window corner and eyes" checked={hudEnabled} onChange={actions.setHud} />
            <Toggle label="Director" hint="Auto-play the reel's phase sequence" checked={directorRunning} onChange={() => actions.toggleDirector()} />
            <Toggle label="Mirror" checked={mirrored} onChange={() => actions.toggleMirror()} />
            {onSwitchCamera ? (
              <div className="af-row">
                <span>Camera</span>
                <IconButton label="Switch camera" icon={<SwitchCameraIcon />} onClick={onSwitchCamera} />
              </div>
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
