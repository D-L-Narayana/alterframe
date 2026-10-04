import { describe, it, expect } from 'vitest';
import { serializeSettings, deserializeSettings, SETTINGS_VERSION, SETTINGS_STORAGE_KEY, createMemoryStorage, defaultSettings, type SettingsData } from '@/state/persistence';
import { DEFAULT_CAPTURE_SETTINGS, DEFAULT_INTERACTION_SETTINGS, DEFAULT_LOOK, DEFAULT_QUALITY } from '@/types';

describe('settings persistence', () => {
  it('serializes only data keys with a version envelope', () => {
    const json = serializeSettings(defaultSettings());
    const obj = JSON.parse(json) as { version: number; settings: Record<string, unknown> };
    expect(obj.version).toBe(SETTINGS_VERSION);
    expect(Object.keys(obj.settings).sort()).toEqual([
      'adaptiveQuality', 'capture', 'debugLandmarks', 'fitMode', 'hudEnabled', 'hudTintAuto', 'interaction', 'look', 'mirrored', 'quality', 'reducedMotion', 'showFps', 'thinStripGlitch',
    ]);
  });

  it('deserializes known keys, drops unknown ones and clamps ranges', () => {
    const parsed = deserializeSettings(JSON.stringify({
      version: SETTINGS_VERSION,
      settings: { mirrored: false, bogus: 1, quality: { renderScale: 5, maxDpr: 2, segmentationStride: 0 }, interaction: { holdMs: -5 } },
    }));
    expect(parsed).not.toBeNull();
    expect(parsed?.mirrored).toBe(false);
    expect((parsed as Record<string, unknown>).bogus).toBeUndefined();
    expect(parsed?.quality?.renderScale).toBe(1);
    expect(parsed?.quality?.segmentationStride).toBe(1);
    expect(parsed?.interaction?.holdMs).toBe(0);
    expect(parsed?.interaction?.ordering).toBe('convex');
  });

  it('returns null on garbage', () => {
    expect(deserializeSettings('nope')).toBeNull();
    expect(deserializeSettings(JSON.stringify({ version: 0 }))).toBeNull();
    expect(deserializeSettings(JSON.stringify(null))).toBeNull();
  });

  it('memory storage get/set/remove', () => {
    const s = createMemoryStorage();
    expect(s.get('k')).toBeNull();
    s.set('k', 'v');
    expect(s.get('k')).toBe('v');
    s.remove('k');
    expect(s.get('k')).toBeNull();
  });
});

describe('settings persistence v2 (v0.2 fields)', () => {
  it('uses a v2 envelope/key and rejects the v1 envelope instead of guessing a migration', () => {
    expect(SETTINGS_VERSION).toBe(2);
    expect(SETTINGS_STORAGE_KEY).toBe('alterframe.settings.v2');
    expect(deserializeSettings(JSON.stringify({ version: 1, settings: { mirrored: false } }))).toBeNull();
  });

  it('defaults reproduce the v0.1 look and behaviour exactly', () => {
    const d = defaultSettings();
    expect(d.fitMode).toBe('cover');
    expect(d.thinStripGlitch).toBe(false);
    expect(d.look).toEqual(DEFAULT_LOOK);
    expect(d.look).toEqual({ inkWidth: 1, inkThreshold: 1, halftone: 1, saturation: 1, bands: 6, grain: 1, overlayStrength: 1 });
    expect(d.capture).toEqual(DEFAULT_CAPTURE_SETTINGS);
    expect(d.capture).toEqual({ aspect: 'source', selfTimer: 0, autoStop: 0, snapshotFormat: 'png', dwellAction: 'off' });
    expect(d.interaction.cornerSpring).toBe(0);
    expect(d.interaction.dwellMs).toBe(0);
    expect(d.interaction.dwellTolerance).toBe(0.012);
    expect(d.quality.inferenceMaxHeight).toBe(720);
    expect(d.quality.faceStride).toBe(1);
  });

  it('round-trips every v0.2 field through serialize → deserialize', () => {
    const custom: SettingsData = {
      ...defaultSettings(),
      fitMode: 'contain',
      thinStripGlitch: true,
      look: { inkWidth: 2, inkThreshold: 0.5, halftone: 0, saturation: 1.5, bands: 4, grain: 2.5, overlayStrength: 0.3 },
      capture: { aspect: '9:16', selfTimer: 5, autoStop: 30, snapshotFormat: 'webp', dwellAction: 'record' },
      interaction: { ...DEFAULT_INTERACTION_SETTINGS, cornerSpring: 0.4, dwellMs: 1500, dwellTolerance: 0.02 },
      quality: { ...DEFAULT_QUALITY, inferenceMaxHeight: 480, faceStride: 2 },
    };
    expect(deserializeSettings(serializeSettings(custom))).toEqual(custom);
  });

  it('clamps the v0.2 numeric fields and falls back for unknown enum values', () => {
    const parsed = deserializeSettings(JSON.stringify({
      version: SETTINGS_VERSION,
      settings: {
        fitMode: 'stretch',
        thinStripGlitch: 'yes',
        look: { inkWidth: 10, inkThreshold: 0, halftone: -1, saturation: 9, bands: 2.4, grain: 99, overlayStrength: 2 },
        capture: { aspect: '4:3', selfTimer: 4, autoStop: 7, snapshotFormat: 'gif', dwellAction: 'both' },
        interaction: { cornerSpring: 2, dwellMs: -5, dwellTolerance: 5 },
        quality: { inferenceMaxHeight: 10_000, faceStride: 9 },
      },
    }));
    expect(parsed?.fitMode).toBe('cover');
    expect(parsed?.thinStripGlitch).toBe(false);
    expect(parsed?.look).toEqual({ inkWidth: 3, inkThreshold: 0.25, halftone: 0, saturation: 2, bands: 3, grain: 3, overlayStrength: 1 });
    expect(parsed?.capture).toEqual(DEFAULT_CAPTURE_SETTINGS);
    expect(parsed?.interaction?.cornerSpring).toBe(0.9);
    expect(parsed?.interaction?.dwellMs).toBe(0);
    expect(parsed?.interaction?.dwellTolerance).toBe(0.2);
    expect(parsed?.quality?.inferenceMaxHeight).toBe(2160);
    expect(parsed?.quality?.faceStride).toBe(4);
  });

  it('fills missing nested v0.2 fields from the defaults (partial payloads)', () => {
    const parsed = deserializeSettings(JSON.stringify({ version: SETTINGS_VERSION, settings: { look: { bands: 8 }, capture: { selfTimer: 10 }, quality: { renderScale: 0.7 } } }));
    expect(parsed?.look).toEqual({ ...DEFAULT_LOOK, bands: 8 });
    expect(parsed?.capture).toEqual({ ...DEFAULT_CAPTURE_SETTINGS, selfTimer: 10 });
    expect(parsed?.quality).toEqual({ ...DEFAULT_QUALITY, renderScale: 0.7 });
  });
});
