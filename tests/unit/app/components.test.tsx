/**
 * Component regressions rendered with react-dom/server (no DOM / testing-library needed).
 * Checks semantics: roles, aria attributes, labels, keyboard hints.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RuntimeDiagnostics } from '@/types';
import { Button, IconButton, Toggle, Segmented, Slider, Kbd } from '@/ui';
import { Onboarding, PRIVACY_LINE } from '@/app/Onboarding';
import { ErrorPanel } from '@/app/ErrorPanel';
import { HelpDialog } from '@/app/HelpDialog';
import { ControlsBar, RecordingIndicator, FpsBadge, PERSONA_OPTIONS, BASE_OPTIONS } from '@/app/ControlsBar';
import { Stage } from '@/app/Stage';
import { SettingsSheet } from '@/app/SettingsSheet';
import { Transport } from '@/app/Transport';
import { CoachHint } from '@/app/CoachHint';
import { CountdownStatus } from '@/app/CountdownBanner';
import { Diagnostics, formatDiagnostics, copyToClipboard, DIAGNOSTIC_ROWS } from '@/app/Diagnostics';
import { StatusToast, ToastLiveRegions } from '@/app/StatusToast';
import { useUiStore } from '@/state/uiStore';
import type { AppActions } from '@/app/useActions';

// SSR-safe: mock CSS imports are not needed because components import no CSS (App.tsx does).
vi.mock('@/app/runtimeBridge', () => ({ startRuntime: vi.fn(), createCameraSource: vi.fn(), createFileSource: vi.fn() }));

const noopActions: AppActions = {
  setPersona: vi.fn(), toggleBase: vi.fn(), toggleHud: vi.fn(), toggleRecord: vi.fn(), snapshot: vi.fn(),
  toggleDirector: vi.fn(), toggleMirror: vi.fn(), toggleFps: vi.fn(), toggleHelp: vi.fn(), escape: vi.fn(),
  timedRecord: vi.fn(), togglePlayback: vi.fn(), seekBy: vi.fn(), toggleLoop: vi.fn(),
  setBase: vi.fn(), cyclePersona: vi.fn(), setHud: vi.fn(), startRecording: vi.fn(async () => {}), stopRecording: vi.fn(async () => {}),
  cancelCountdown: vi.fn(), retryTracker: vi.fn(), continueWithoutTracking: vi.fn(),
  openSettings: vi.fn(), closePanels: vi.fn(),
};

const sampleDiagnostics: RuntimeDiagnostics = {
  fps: 29.6,
  frameMs: 33.4,
  trackingMs: 12.25,
  renderMs: 8.5,
  gpuMs: null,
  frames: 1234,
  tracker: { ready: true, progress: 1, error: null, delegates: { hands: 'GPU', face: 'GPU', segmentation: 'CPU' }, inferenceSize: { width: 640, height: 360 }, warnings: ['segmentation fell back to CPU'] },
  renderer: { contextLost: false, contextLossCount: 1, internal: { width: 1280, height: 720 }, maskFormat: 'R8' },
  quality: { renderScale: 0.85, maxDpr: 2, segmentationStride: 2, inferenceMaxHeight: 480, faceStride: 1 },
  source: { kind: 'camera', status: 'ready', width: 1280, height: 720 },
  modules: { stubbed: [] },
};

describe('ui primitives', () => {
  it('Button defaults to type=button and variant classes', () => {
    const html = renderToStaticMarkup(<Button variant="primary">Go</Button>);
    expect(html).toContain('type="button"');
    expect(html).toContain('af-btn--primary');
  });

  it('IconButton exposes label + aria-pressed when toggled', () => {
    const html = renderToStaticMarkup(<IconButton label="Mirror" shortcut="M" icon={<svg />} pressed />);
    expect(html).toContain('aria-label="Mirror"');
    expect(html).toContain('title="Mirror (M)"');
    expect(html).toContain('aria-pressed="true"');
  });

  it('Toggle is a switch with aria-checked', () => {
    const html = renderToStaticMarkup(<Toggle label="HUD" checked onChange={() => {}} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });

  it('Segmented is a radiogroup with roving tabindex', () => {
    const html = renderToStaticMarkup(
      <Segmented label="Persona" value="masked" onChange={() => {}} options={PERSONA_OPTIONS} />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)?.length).toBe(3);
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Masked hero"');
  });

  it('Slider is a labelled range input with aria-valuetext', () => {
    const html = renderToStaticMarkup(<Slider label="Render scale" min={0.5} max={1} step={0.05} value={0.75} onChange={() => {}} format={(v) => `${v * 100}%`} />);
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-valuetext="75%"');
    expect(html).toMatch(/<label for="[^"]+"/);
  });

  it('Kbd renders a kbd element', () => {
    expect(renderToStaticMarkup(<Kbd>R</Kbd>)).toBe('<kbd class="af-kbd">R</kbd>');
  });
});

describe('app screens', () => {
  it('Onboarding has the privacy line, both entry buttons and a heading', () => {
    const html = renderToStaticMarkup(<Onboarding onUseCamera={() => {}} onOpenFile={() => {}} cameraSupported />);
    expect(html).toContain(PRIVACY_LINE);
    expect(html).toContain('Use camera');
    expect(html).toContain('Open a video file');
    expect(html).toContain('<h1');
    expect(html).toContain('accept="video/*"');
  });

  it('Onboarding disables the camera button when unsupported', () => {
    const html = renderToStaticMarkup(<Onboarding onUseCamera={() => {}} onOpenFile={() => {}} cameraSupported={false} />);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Use camera/);
  });

  it('ErrorPanel is an alert with retry + file fallback', () => {
    const html = renderToStaticMarkup(<ErrorPanel status="denied" message="Nope" onRetry={() => {}} onOpenFile={() => {}} onBack={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Camera permission needed');
    expect(html).toContain('Nope');
    expect(html).toContain('Try again');
    expect(html).toContain('Open a video file');
  });

  it('Stage renders the full-viewport canvas with id and aria-label', () => {
    const html = renderToStaticMarkup(<Stage loading />);
    expect(html).toContain('<canvas id="stage"');
    expect(html).toContain('aria-label="Live stage');
    expect(html).toContain('Loading tracking models');
  });

  it('HelpDialog renders nothing when closed and the full key map when open', () => {
    expect(renderToStaticMarkup(<HelpDialog open={false} onClose={() => {}} />)).toBe('');
    const html = renderToStaticMarkup(<HelpDialog open onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    for (const k of ['1', '2', '3', 'B', 'H', 'R', 'S', 'T', 'D', 'M', 'F', 'P', '[', ']', 'L', '?', 'Esc']) expect(html, k).toContain(`<kbd class="af-kbd">${k}</kbd>`);
  });

  it('ControlsBar shows every documented control (desktop layout)', () => {
    // Note: react-dom/server reads zustand's initial snapshot, so this covers the idle state.
    const html = renderToStaticMarkup(<ControlsBar actions={noopActions} onSwitchCamera={() => {}} />);
    for (const label of ['Persona', 'Base style', 'HUD callouts', 'Play director sequence', 'Mirror', 'Switch camera', 'Start recording', 'Snapshot', 'Settings', 'Help']) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('title="Start recording (R)"');
    expect(BASE_OPTIONS.map((o) => o.value)).toEqual(['live', 'comic']);
    expect(PERSONA_OPTIONS.map((o) => o.value)).toEqual(['portrait', 'masked', 'suit']);
    // Without a camera alternative the switch button is hidden.
    expect(renderToStaticMarkup(<ControlsBar actions={noopActions} onSwitchCamera={null} />)).not.toContain('Switch camera');
  });

  it('RecordingIndicator and FpsBadge render elapsed time and fps', () => {
    const rec = renderToStaticMarkup(<RecordingIndicator elapsedMs={65_000} />);
    expect(rec).toContain('01:05');
    expect(rec).toContain('af-controls__dot');
    expect(rec).toContain('aria-label="Recording, 01:05"');
    expect(renderToStaticMarkup(<FpsBadge fps={29.6} />)).toContain('30 fps');
  });

  it('RecordingIndicator names the auto-stop remaining time when one is armed', () => {
    const rec = renderToStaticMarkup(<RecordingIndicator elapsedMs={5_000} autoStopMs={15_000} />);
    expect(rec).toContain('aria-label="Recording, 00:05, stops in 00:10"');
    expect(rec).toContain('00:05');
    // Never negative once the timer has elapsed.
    expect(renderToStaticMarkup(<RecordingIndicator elapsedMs={16_000} autoStopMs={15_000} />)).toContain('stops in 00:00');
    expect(renderToStaticMarkup(<RecordingIndicator elapsedMs={5_000} autoStopMs={null} />)).toContain('aria-label="Recording, 00:05"');
  });

  it('SettingsSheet exposes every required setting group and control name', () => {
    useUiStore.getState().openPanel('settings');
    const html = renderToStaticMarkup(<SettingsSheet open onClose={() => {}} getDiagnostics={() => sampleDiagnostics} />);
    useUiStore.getState().closePanel();
    expect(html).toContain('role="dialog"');
    // v0.1 names (unchanged).
    for (const text of ['Corner ordering', 'Faithful', 'Hands-together cycles persona', 'Hold before fade', 'Render scale', 'Adaptive quality', 'Debug landmarks', 'Callout colour', 'Reduce motion', 'Capture aspect']) {
      expect(html, text).toContain(text);
    }
    // Groups.
    for (const group of ['Window &amp; gestures', 'Quality', 'Look', 'HUD', 'Display', 'Capture', 'Diagnostics']) expect(html, group).toContain(`>${group}</h3>`);
    // v0.2 control names.
    for (const name of [
      'Corner smoothing', 'Hold still to capture', 'Hold time',
      'Tracking resolution', 'Face every N frames',
      'Ink thickness', 'Ink threshold', 'Halftone', 'Saturation', 'Colour bands', 'Grain', 'Overlay strength', 'Reset look',
      'Display fit', 'Thin-slit glitch',
      'Self-timer', 'Auto-stop', 'Snapshot format',
      'Copy diagnostics', 'Reset to defaults',
    ]) {
      expect(html, name).toContain(name);
    }
    // Segmented option labels.
    for (const opt of ['Off', '3 s', '5 s', '10 s', '15 s', '30 s', '60 s', 'PNG', 'JPEG', 'WebP', 'Fill', 'Fit', 'Full', '480p', '360p', 'Snapshot', 'Record']) {
      expect(html, opt).toContain(`>${opt}<`);
    }
    // Accessible names on the radiogroups.
    for (const label of ['Hold still to capture', 'Tracking resolution', 'Display fit', 'Capture aspect', 'Self-timer', 'Auto-stop', 'Snapshot format']) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
    // Adaptive quality (default on) disables the manual quality rungs with the explanation.
    expect(html.match(/Managed automatically/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // Diagnostics rows.
    for (const row of DIAGNOSTIC_ROWS) expect(html, row).toContain(`<dt>${row}</dt>`);
    expect(html).toContain('GPU hands · GPU face · CPU segmentation');
  });

  it('StatusToast exposes role=status (polite) and role=alert (assertive) live regions', () => {
    // SSR reads zustand's initial snapshot, so the regions are asserted through the presentational component.
    const polite = renderToStaticMarkup(<ToastLiveRegions toast={{ id: 1, message: 'Countdown cancelled', kind: 'status' }} />);
    expect(polite).toMatch(/<div class="af-visually-hidden" role="status" aria-live="polite" aria-atomic="true">Countdown cancelled<\/div>/);
    expect(polite).toMatch(/role="alert" aria-live="assertive" aria-atomic="true"><\/div>/);
    const assertive = renderToStaticMarkup(<ToastLiveRegions toast={{ id: 2, message: 'Copy failed — select the text below', kind: 'error' }} />);
    expect(assertive).toMatch(/role="alert" aria-live="assertive" aria-atomic="true">Copy failed — select the text below<\/div>/);
    expect(assertive).toMatch(/role="status" aria-live="polite" aria-atomic="true"><\/div>/);
    // Mounted component: both regions always exist (empty when idle); the visible toast is decorative.
    const idle = renderToStaticMarkup(<StatusToast />);
    expect(idle).toContain('role="status" aria-live="polite"');
    expect(idle).toContain('role="alert" aria-live="assertive"');
    expect(idle).toContain('class="af-toast-region" aria-hidden="true"');
  });

  it('SettingsSheet diagnostics degrade gracefully without a runtime', () => {
    const html = renderToStaticMarkup(<SettingsSheet open onClose={() => {}} />);
    expect(html).toContain('<dt>Tracking</dt>');
    expect(html).toContain('n/a');
    expect(html).toContain('Copy diagnostics');
  });
});

describe('transport, coach hint, countdown', () => {
  it('Transport is a Playback nav with Play/Pause, Seek (mm:ss) and Loop', () => {
    const paused = renderToStaticMarkup(<Transport state={{ paused: true, currentTime: 65.2, duration: 120, loop: false }} getTransport={() => null} />);
    expect(paused).toContain('<nav');
    expect(paused).toContain('aria-label="Playback"');
    expect(paused).toContain('aria-label="Play"');
    expect(paused).not.toContain('aria-label="Pause"');
    expect(paused).toContain('type="range"');
    expect(paused).toContain('aria-label="Seek"');
    expect(paused).toContain('aria-valuetext="01:05"');
    expect(paused).toContain('max="120"');
    expect(paused).toContain('min="0"');
    expect(paused).toContain('role="switch"');
    expect(paused).toContain('aria-checked="false"');
    expect(paused).toContain('>Loop<');

    const playing = renderToStaticMarkup(<Transport state={{ paused: false, currentTime: 3, duration: 120, loop: true }} getTransport={() => null} />);
    expect(playing).toContain('aria-label="Pause"');
    expect(playing).not.toContain('aria-label="Play"');
    expect(playing).toContain('aria-checked="true"');
  });

  it('Transport tolerates an unknown duration (NaN before metadata)', () => {
    const html = renderToStaticMarkup(<Transport state={{ paused: true, currentTime: 0, duration: Number.NaN, loop: true }} getTransport={() => null} />);
    expect(html).toContain('max="0"');
    expect(html).toContain('aria-valuetext="00:00"');
  });

  it('CoachHint is a status region with the L-shape instruction and a dismiss button', () => {
    const html = renderToStaticMarkup(<CoachHint onDismiss={() => {}} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Raise both hands in an L shape — index up, thumb in');
    expect(html).toContain('Dismiss hint');
  });

  it('CountdownStatus announces the seconds left for both actions with a Cancel button', () => {
    const rec = renderToStaticMarkup(<CountdownStatus action="record" secondsLeft={3} onCancel={() => {}} />);
    expect(rec).toContain('role="status"');
    expect(rec).toMatch(/Recording starts in 3/);
    expect(rec).toContain('Cancel countdown');
    const snap = renderToStaticMarkup(<CountdownStatus action="snapshot" secondsLeft={5} onCancel={() => {}} />);
    expect(snap).toMatch(/Snapshot in 5/);
  });
});

describe('diagnostics', () => {
  it('formats every row from a diagnostics snapshot', () => {
    const rows = Object.fromEntries(formatDiagnostics(sampleDiagnostics).map((r) => [r.term, r.detail]));
    expect(Object.keys(rows)).toEqual([...DIAGNOSTIC_ROWS]);
    expect(rows.Tracking).toContain('Ready');
    expect(rows.Tracking).toContain('GPU hands · GPU face · CPU segmentation');
    expect(rows.Frame).toMatch(/30 fps/);
    expect(rows.Frame).toMatch(/33\.4 ms/);
    expect(rows['Tracking time']).toBe('12.3 ms');
    expect(rows['Render time']).toBe('8.5 ms');
    expect(rows['GPU time']).toBe('n/a');
    expect(rows.Quality).toContain('85%');
    expect(rows.Quality).toMatch(/480/);
    expect(rows.Quality).toMatch(/640×360/);
    expect(rows.Renderer).toContain('1280×720');
    expect(rows.Renderer).toContain('R8');
    expect(rows.Renderer).toMatch(/lost 1/);
    expect(rows.Source).toContain('camera');
    expect(rows.Source).toContain('ready');
    expect(rows.Source).toContain('1280×720');
  });

  it('formats loading / failed tracking and a measured GPU time', () => {
    const loading = formatDiagnostics({ ...sampleDiagnostics, tracker: { ...sampleDiagnostics.tracker, ready: false, progress: 0.42, delegates: null } });
    expect(loading.find((r) => r.term === 'Tracking')?.detail).toMatch(/Loading 42%/);
    const failed = formatDiagnostics({ ...sampleDiagnostics, tracker: { ...sampleDiagnostics.tracker, ready: false, error: '404 hand_landmarker.task', delegates: null } });
    expect(failed.find((r) => r.term === 'Tracking')?.detail).toMatch(/Failed: 404 hand_landmarker.task/);
    const gpu = formatDiagnostics({ ...sampleDiagnostics, gpuMs: 4.257 });
    expect(gpu.find((r) => r.term === 'GPU time')?.detail).toBe('4.26 ms');
    const noRenderer = formatDiagnostics({ ...sampleDiagnostics, renderer: null });
    expect(noRenderer.find((r) => r.term === 'Renderer')?.detail).toBe('n/a');
  });

  it('renders n/a rows without a runtime', () => {
    const rows = formatDiagnostics(null);
    expect(rows.map((r) => r.term)).toEqual([...DIAGNOSTIC_ROWS]);
    expect(rows.find((r) => r.term === 'Tracking')?.detail).toBe('Not running');
    expect(rows.filter((r) => r.detail === 'n/a').length).toBe(DIAGNOSTIC_ROWS.length - 1);
  });

  it('Diagnostics renders a <dl> and the copy button; a visible <pre> only after a failed copy', () => {
    const html = renderToStaticMarkup(<Diagnostics getDiagnostics={() => sampleDiagnostics} />);
    expect(html).toContain('<dl');
    expect(html.match(/<dt>/g)?.length).toBe(DIAGNOSTIC_ROWS.length);
    expect(html).toContain('Copy diagnostics');
    expect(html).not.toContain('<pre');
  });

  it('copyToClipboard reports success/failure instead of throwing', async () => {
    await expect(copyToClipboard('x', { writeText: async () => {} })).resolves.toBe(true);
    await expect(copyToClipboard('x', { writeText: async () => { throw new Error('denied'); } })).resolves.toBe(false);
    await expect(copyToClipboard('x', undefined)).resolves.toBe(false);
  });
});
