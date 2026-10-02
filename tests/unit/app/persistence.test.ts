import { describe, it, expect } from 'vitest';
import { serializeSettings, deserializeSettings, SETTINGS_VERSION, createMemoryStorage, defaultSettings } from '@/state/persistence';

describe('settings persistence', () => {
  it('serializes only data keys with a version envelope', () => {
    const json = serializeSettings(defaultSettings());
    const obj = JSON.parse(json) as { version: number; settings: Record<string, unknown> };
    expect(obj.version).toBe(SETTINGS_VERSION);
    expect(Object.keys(obj.settings).sort()).toEqual([
      'adaptiveQuality', 'debugLandmarks', 'hudEnabled', 'hudTintAuto', 'interaction', 'mirrored', 'quality', 'reducedMotion', 'showFps',
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
