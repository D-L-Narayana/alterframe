import { describe, it, expect } from 'vitest';
import { STYLE_PRESETS, COMIC_BASE_PRESET, presetForLayer } from '../../../src/render/styles';
import { DEFAULT_SCENE } from '../../../src/types/scene';

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
