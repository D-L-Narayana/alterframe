import { describe, it, expect, beforeEach } from 'vitest';
import { createAppStore, selectScene, selectSettings, selectSession, useAppStore } from '@/state/store';
import { createMemoryStorage, SETTINGS_STORAGE_KEY } from '@/state/persistence';
import { PERSONA_ORDER, DEFAULT_SCENE } from '@/types';

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
    a.getState().setSettings({ mirrored: false, showFps: true, quality: { renderScale: 0.75, maxDpr: 2, segmentationStride: 2 } });
    expect(storage.get(SETTINGS_STORAGE_KEY)).toBeTypeOf('string');
    const b = createAppStore({ storage });
    expect(b.getState().mirrored).toBe(false);
    expect(b.getState().showFps).toBe(true);
    expect(b.getState().quality.renderScale).toBe(0.75);
    // functions are never persisted
    expect(storage.get(SETTINGS_STORAGE_KEY)).not.toContain('setSettings');
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
