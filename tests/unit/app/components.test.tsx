/**
 * Component regressions rendered with react-dom/server (no DOM / testing-library needed).
 * Checks semantics: roles, aria attributes, labels, keyboard hints.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, IconButton, Toggle, Segmented, Slider, Kbd } from '@/ui';
import { Onboarding, PRIVACY_LINE } from '@/app/Onboarding';
import { ErrorPanel } from '@/app/ErrorPanel';
import { HelpDialog } from '@/app/HelpDialog';
import { ControlsBar, RecordingIndicator, FpsBadge, PERSONA_OPTIONS, BASE_OPTIONS } from '@/app/ControlsBar';
import { Stage } from '@/app/Stage';
import { SettingsSheet } from '@/app/SettingsSheet';
import { useUiStore } from '@/state/uiStore';
import type { AppActions } from '@/app/useActions';

// SSR-safe: mock CSS imports are not needed because components import no CSS (App.tsx does).
vi.mock('@/app/runtimeBridge', () => ({ startRuntime: vi.fn(), createCameraSource: vi.fn(), createFileSource: vi.fn() }));

const noopActions: AppActions = {
  setPersona: vi.fn(), toggleBase: vi.fn(), toggleHud: vi.fn(), toggleRecord: vi.fn(), snapshot: vi.fn(),
  toggleDirector: vi.fn(), toggleMirror: vi.fn(), toggleFps: vi.fn(), toggleHelp: vi.fn(), escape: vi.fn(),
  setBase: vi.fn(), cyclePersona: vi.fn(), setHud: vi.fn(), startRecording: vi.fn(async () => {}), stopRecording: vi.fn(async () => {}),
  openSettings: vi.fn(), closePanels: vi.fn(),
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

  it('HelpDialog renders nothing when closed and the key map when open', () => {
    expect(renderToStaticMarkup(<HelpDialog open={false} onClose={() => {}} />)).toBe('');
    const html = renderToStaticMarkup(<HelpDialog open onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    for (const k of ['1', '2', '3', 'B', 'H', 'R', 'S', 'D', 'M', 'F', '?', 'Esc']) expect(html).toContain(`<kbd class="af-kbd">${k}</kbd>`);
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

  it('SettingsSheet exposes every required setting group', () => {
    useUiStore.getState().openPanel('settings');
    const html = renderToStaticMarkup(<SettingsSheet open onClose={() => {}} />);
    for (const text of ['Corner ordering', 'Faithful', 'Hands-together cycles persona', 'Hold before fade', 'Render scale', 'Adaptive quality', 'Debug landmarks', 'Callout colour', 'Reduce motion', 'Capture aspect']) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain('role="dialog"');
    useUiStore.getState().closePanel();
  });
});
