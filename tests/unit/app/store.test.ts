import { describe, it, expect, beforeEach } from 'vitest';
import { createAppStore, selectScene, selectSettings, selectSession, useAppStore } from '@/state/store';
import { createMemoryStorage, SETTINGS_STORAGE_KEY } from '@/state/persistence';
import { useUiStore } from '@/state/uiStore';
import { PERSONA_ORDER, DEFAULT_SCENE, DEFAULT_CAPTURE_SETTINGS, DEFAULT_LOOK } from '@/types';

describe('useAppStore', () => {
  beforeEach(() => {
    useAppStore.getState().setScene(DEFAULT_SCENE);
    useAppStore.getState().setSettings({ hudTintAuto: true });
  });

  it('exports a bound zustand store with defaults from contracts', () => {
    const s = useAppStore.getState();
    expect(s.scene).toEqual(DEFAULT_SCENE);
    expect(s.sourceStatus).toBe('idle');
    expect(s.recorderState).toBe('idle');
    expect(s.directorRunning).toBe(false);
    expect(s.interaction.ordering).toBe('convex');
    expect(s.quality.renderScale).toBe(1);
  });

  it('settings slice carries the v0.2 fields at v0.1-identical defaults', () => {
    const s = useAppStore.getState();
    expect(s.fitMode).toBe('cover');
    expect(s.thinStripGlitch).toBe(false);
    expect(s.look).toEqual(DEFAULT_LOOK);
    expect(s.capture).toEqual(DEFAULT_CAPTURE_SETTINGS);
    expect(s.interaction.cornerSpring).toBe(0);
    expect(s.interaction.dwellMs).toBe(0);
    expect(s.quality.inferenceMaxHeight).toBe(720);
    expect(s.quality.faceStride).toBe(1);
  });

  it('session slice carries the v0.2 fields with inert defaults', () => {
    const s = useAppStore.getState();
    expect(s.trackerProgress).toBe(0);
    expect(s.trackerError).toBeNull();
    expect(s.windowOpen).toBe(false);
    expect(s.contextLost).toBe(false);
    expect(s.countdown).toBeNull();
    expect(s.transport).toBeNull();
    expect(s.captureRequest).toBeNull();
    const picked = selectSession(s);
    for (const k of ['trackerProgress', 'trackerError', 'windowOpen', 'contextLost', 'countdown', 'transport', 'captureRequest'] as const) expect(k in picked, k).toBe(true);
    const settings = selectSettings(s);
    for (const k of ['fitMode', 'thinStripGlitch', 'look', 'capture'] as const) expect(k in settings, k).toBe(true);
  });

  it('cyclePersona wraps portrait→masked→suit→portrait', () => {
    const seen: string[] = [useAppStore.getState().scene.persona];
    for (let i = 0; i < 3; i++) {
      useAppStore.getState().cyclePersona();
      seen.push(useAppStore.getState().scene.persona);
    }
    expect(seen).toEqual([...PERSONA_ORDER, PERSONA_ORDER[0]]);
  });

  it('setScene({base:"comic"}) sets hudTint red when auto, white when back to live', () => {
    useAppStore.getState().setScene({ base: 'comic' });
    expect(useAppStore.getState().scene.hudTint).toBe('red');
    useAppStore.getState().setScene({ base: 'live' });
    expect(useAppStore.getState().scene.hudTint).toBe('white');
  });

  it('respects a manual hudTint when hudTintAuto is off, and recomputes when turned back on', () => {
    useAppStore.getState().setSettings({ hudTintAuto: false });
    useAppStore.getState().setScene({ base: 'comic', hudTint: 'white' });
    expect(useAppStore.getState().scene.hudTint).toBe('white');
    useAppStore.getState().setSettings({ hudTintAuto: true });
    expect(useAppStore.getState().scene.hudTint).toBe('red');
  });

  it('setSession merges partial session state', () => {
    useAppStore.getState().setSession({ sourceStatus: 'requesting', sourceKind: 'file' });
    const s = useAppStore.getState();
    expect(s.sourceStatus).toBe('requesting');
    expect(s.sourceKind).toBe('file');
    expect(s.fps).toBe(0);
    useAppStore.getState().setSession({ sourceStatus: 'idle', sourceKind: 'camera' });
  });

  it('setSession carries the v0.2 session objects by reference (runtime → UI)', () => {
    const countdown = { action: 'record', endsAt: 1234, totalMs: 3000 } as const;
    const transport = { paused: true, currentTime: 1.5, duration: 10, loop: false };
    const captureRequest = { action: 'snapshot', id: 1, source: 'dwell' } as const;
    useAppStore.getState().setSession({ countdown, transport, captureRequest, trackerProgress: 0.5, trackerError: 'boom', windowOpen: true, contextLost: true });
    const s = useAppStore.getState();
    expect(s.countdown).toBe(countdown);
    expect(s.transport).toBe(transport);
    expect(s.captureRequest).toBe(captureRequest);
    expect(s.trackerProgress).toBe(0.5);
    expect(s.trackerError).toBe('boom');
    expect(s.windowOpen).toBe(true);
    expect(s.contextLost).toBe(true);
    useAppStore.getState().setSession({ countdown: null, transport: null, captureRequest: null, trackerProgress: 0, trackerError: null, windowOpen: false, contextLost: false });
  });

  it('selectors pick the right slices', () => {
    const s = useAppStore.getState();
    expect(selectScene(s)).toBe(s.scene);
    expect(selectSettings(s).mirrored).toBe(s.mirrored);
    expect(selectSession(s).sourceStatus).toBe(s.sourceStatus);
  });
});

describe('createAppStore persistence', () => {
  it('round-trips persisted settings through storage', () => {
    const storage = createMemoryStorage();
    const a = createAppStore({ storage });
    a.getState().setSettings({ mirrored: false, showFps: true, quality: { renderScale: 0.75, maxDpr: 2, segmentationStride: 2, inferenceMaxHeight: 720, faceStride: 1 } });
    expect(storage.get(SETTINGS_STORAGE_KEY)).toBeTypeOf('string');
    const b = createAppStore({ storage });
    expect(b.getState().mirrored).toBe(false);
    expect(b.getState().showFps).toBe(true);
    expect(b.getState().quality.renderScale).toBe(0.75);
    // functions are never persisted
    expect(storage.get(SETTINGS_STORAGE_KEY)).not.toContain('setSettings');
  });

  it('round-trips the v0.2 settings groups (capture, look, fit, glitch)', () => {
    const storage = createMemoryStorage();
    const a = createAppStore({ storage });
    a.getState().setSettings({
      capture: { aspect: '1:1', selfTimer: 5, autoStop: 15, snapshotFormat: 'jpeg', dwellAction: 'snapshot' },
      look: { ...DEFAULT_LOOK, inkWidth: 1.5, bands: 5 },
      fitMode: 'contain',
      thinStripGlitch: true,
    });
    const b = createAppStore({ storage });
    expect(b.getState().capture).toEqual({ aspect: '1:1', selfTimer: 5, autoStop: 15, snapshotFormat: 'jpeg', dwellAction: 'snapshot' });
    expect(b.getState().look).toEqual({ ...DEFAULT_LOOK, inkWidth: 1.5, bands: 5 });
    expect(b.getState().fitMode).toBe('contain');
    expect(b.getState().thinStripGlitch).toBe(true);
  });

  it('ignores corrupt or wrong-version payloads', () => {
    const storage = createMemoryStorage();
    storage.set(SETTINGS_STORAGE_KEY, '{not json');
    expect(createAppStore({ storage }).getState().mirrored).toBe(true);
    storage.set(SETTINGS_STORAGE_KEY, JSON.stringify({ version: 999, settings: { mirrored: false } }));
    expect(createAppStore({ storage }).getState().mirrored).toBe(true);
  });

  it('does not touch window storage (memory-only by default)', () => {
    const g = globalThis as { localStorage?: unknown };
    expect(g.localStorage).toBeUndefined();
    useAppStore.getState().setSettings({ showFps: false });
  });
});

describe('useUiStore', () => {
  it('no longer owns the capture aspect (it lives in settings.capture.aspect)', () => {
    expect('captureAspect' in useUiStore.getState()).toBe(false);
    expect('setCaptureAspect' in useUiStore.getState()).toBe(false);
  });

  it('tracks the per-session dismissals and the armed auto-stop length', () => {
    const ui = useUiStore.getState();
    expect(ui.trackerFailureDismissed).toBe(false);
    expect(ui.coachHintDone).toBe(false);
    expect(ui.autoStopMs).toBeNull();
    ui.dismissTrackerFailure();
    expect(useUiStore.getState().trackerFailureDismissed).toBe(true);
    ui.resetTrackerFailure();
    expect(useUiStore.getState().trackerFailureDismissed).toBe(false);
    ui.finishCoachHint();
    expect(useUiStore.getState().coachHintDone).toBe(true);
    ui.setAutoStopMs(10_000);
    expect(useUiStore.getState().autoStopMs).toBe(10_000);
    ui.setAutoStopMs(null);
    expect(useUiStore.getState().autoStopMs).toBeNull();
  });

  it('toasts carry a kind for the two live regions', () => {
    const ui = useUiStore.getState();
    ui.notify('hello');
    expect(useUiStore.getState().toast).toMatchObject({ message: 'hello', kind: 'status' });
    ui.notify('bad', 'error');
    expect(useUiStore.getState().toast).toMatchObject({ message: 'bad', kind: 'error' });
    ui.dismissToast();
    expect(useUiStore.getState().toast).toBeNull();
  });
});
