import { describe, it, expect } from 'vitest';
import { STYLE_PRESETS, COMIC_BASE_PRESET, ALL_PRESETS, presetForLayer } from '../../../src/render/styles';
import { ALL_PASSES } from '../../../src/render/shaders';
import { DEFAULT_SCENE } from '../../../src/types/scene';

describe('ALL_PRESETS (the list the renderer warms up at start)', () => {
  it('is paper-portrait, comic, comic-base — in that order, by identity', () => {
    expect(ALL_PRESETS).toHaveLength(3);
    expect(ALL_PRESETS[0]).toBe(STYLE_PRESETS['paper-portrait']);
    expect(ALL_PRESETS[1]).toBe(STYLE_PRESETS.comic);
    expect(ALL_PRESETS[2]).toBe(COMIC_BASE_PRESET);
  });

  it('has the StylePreset shape on every entry', () => {
    expect(ALL_PRESETS.length).toBe(3); // never vacuous
    for (const preset of ALL_PRESETS) {
      expect(['paper-portrait', 'comic']).toContain(preset.id);
      expect(typeof preset.usesBackdrop).toBe('boolean');
      expect(preset.passes.length).toBeGreaterThan(0);
      for (const pass of preset.passes) expect(ALL_PASSES).toContain(pass);
    }
  });

  it('warming it compiles every shipped pass (the union of its passes is ALL_PASSES)', () => {
    const warmed = new Set(ALL_PRESETS.flatMap((p) => p.passes));
    for (const pass of ALL_PASSES) expect(warmed.has(pass), pass.id).toBe(true);
  });

  it('is frozen so a consumer cannot reorder or extend the shared list', () => {
    expect(Object.isFrozen(ALL_PRESETS)).toBe(true);
  });
});

describe('comic base preset (full-frame stylization without background replacement)', () => {
  it('shares the comic id but skips the backdrop pass and does not use u_backdrop', () => {
    expect(COMIC_BASE_PRESET.id).toBe('comic');
    expect(COMIC_BASE_PRESET.usesBackdrop).toBe(false);
    const ids = COMIC_BASE_PRESET.passes.map((p) => p.id);
    expect(ids).not.toContain('backdrop');
    expect(ids).toEqual(STYLE_PRESETS.comic.passes.map((p) => p.id).filter((id) => id !== 'backdrop'));
    for (const pass of COMIC_BASE_PRESET.passes) expect(pass.frag).not.toMatch(/u_backdrop/);
  });
});

describe('presetForLayer', () => {
  it('window: portrait → paper-portrait, masked/suit → comic (with backdrop)', () => {
    expect(presetForLayer({ ...DEFAULT_SCENE, persona: 'portrait' }, 'window')).toBe(STYLE_PRESETS['paper-portrait']);
    expect(presetForLayer({ ...DEFAULT_SCENE, persona: 'masked' }, 'window')).toBe(STYLE_PRESETS.comic);
    expect(presetForLayer({ ...DEFAULT_SCENE, persona: 'suit' }, 'window')).toBe(STYLE_PRESETS.comic);
  });

  it('base: live → null, comic → COMIC_BASE_PRESET', () => {
    expect(presetForLayer({ ...DEFAULT_SCENE, base: 'live' }, 'base')).toBeNull();
    expect(presetForLayer({ ...DEFAULT_SCENE, base: 'comic' }, 'base')).toBe(COMIC_BASE_PRESET);
  });
});
