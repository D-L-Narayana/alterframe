import { describe, it, expect } from 'vitest';
import { STYLE_PRESETS } from '../../../src/render/styles';
import { ALL_PASSES, PRELUDE, glslUniformDecls } from '../../../src/render/shaders';
import type { PassContext, StylePass, UniformValue } from '../../../src/types/render';
import { DEFAULT_LOOK, DEFAULT_QUALITY } from '../../../src/types/render';
import { DEFAULT_SCENE } from '../../../src/types/scene';

/** Uniform names the core prelude already declares (src/types/render.ts). */
const PRELUDE_UNIFORMS = ['u_color', 'u_video', 'u_mask', 'u_backdrop', 'u_resolution', 'u_texel', 'u_time'];

const ctx: PassContext = { time: 1.5, width: 1280, height: 720, scene: DEFAULT_SCENE, quality: DEFAULT_QUALITY, look: DEFAULT_LOOK };

function glslTypeOf(v: UniformValue): string {
  if (typeof v === 'number') return 'float';
  if (v instanceof Float32Array) return 'float[]';
  return ['', '', 'vec2', 'vec3', 'vec4'][v.length] ?? 'unknown';
}

function uniformsOf(pass: StylePass): Record<string, UniformValue> {
  return pass.uniforms ? pass.uniforms(ctx) : {};
}

describe('GLSL pass bodies', () => {
  it('there are passes and ids are unique', () => {
    expect(ALL_PASSES.length).toBeGreaterThanOrEqual(6);
    const ids = ALL_PASSES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(ALL_PASSES.map((p) => [p.id, p] as const))('%s body has no #version/precision/prelude redeclaration', (_id, pass) => {
    expect(pass.frag).not.toMatch(/#version/);
    expect(pass.frag).not.toMatch(/^\s*precision\s+/m);
    expect(pass.frag).not.toMatch(/\bin\s+vec2\s+v_uv\b/);
    expect(pass.frag).not.toMatch(/\bout\s+vec4\s+fragColor\b/);
    for (const u of PRELUDE_UNIFORMS) {
      // must not redeclare prelude uniforms
      expect(pass.frag).not.toMatch(new RegExp(`uniform\\s+\\w+\\s+${u}\\s*;`));
    }
  });

  it.each(ALL_PASSES.map((p) => [p.id, p] as const))('%s writes fragColor inside main()', (_id, pass) => {
    expect(pass.frag).toMatch(/void\s+main\s*\(\s*\)/);
    expect(pass.frag).toMatch(/fragColor\s*=/);
  });

  it.each(ALL_PASSES.map((p) => [p.id, p] as const))('%s declared uniforms == uniforms() keys with matching GLSL types', (_id, pass) => {
    const decls = glslUniformDecls(pass.frag);
    const provided = uniformsOf(pass);
    const declaredNames = Object.keys(decls).sort();
    const providedNames = Object.keys(provided).sort();
    expect(providedNames).toEqual(declaredNames);
    for (const name of declaredNames) {
      const value = provided[name];
      expect(value, name).toBeDefined();
      expect(glslTypeOf(value as UniformValue), name).toBe(decls[name]);
    }
  });

  it.each(ALL_PASSES.map((p) => [p.id, p] as const))('%s uniform values are finite', (_id, pass) => {
    for (const [name, v] of Object.entries(uniformsOf(pass))) {
      const nums = typeof v === 'number' ? [v] : Array.from(v);
      for (const n of nums) expect(Number.isFinite(n), `${name}`).toBe(true);
    }
  });

  it.each(ALL_PASSES.map((p) => [p.id, p] as const))('%s has a sane scale', (_id, pass) => {
    const s = pass.scale ?? 1;
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it.each(ALL_PASSES.map((p) => [p.id, p] as const))('%s uses no non-core extensions and balanced braces', (_id, pass) => {
    expect(pass.frag).not.toMatch(/#extension/);
    expect(pass.frag).not.toMatch(/texture2D\s*\(/); // GLSL ES 1.00 call
    const open = (pass.frag.match(/\{/g) ?? []).length;
    const close = (pass.frag.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });

  it('prelude matches the contract in src/types/render.ts', () => {
    expect(PRELUDE.startsWith('#version 300 es')).toBe(true);
    for (const u of PRELUDE_UNIFORMS) expect(PRELUDE).toContain(u);
    expect(PRELUDE).toContain('in vec2 v_uv;');
    expect(PRELUDE).toContain('out vec4 fragColor;');
  });
});

describe('uniforms respond to context', () => {
  it('ink width scales with resolution and renderScale, clamped to 1.5..2.5 display px', () => {
    const ink = ALL_PASSES.find((p) => p.id.startsWith('ink'));
    expect(ink?.uniforms).toBeDefined();
    const at = (h: number, rs: number) => ink!.uniforms!({ ...ctx, height: h, width: Math.round(h * 16 / 9), quality: { ...DEFAULT_QUALITY, renderScale: rs } })['u_inkWidth'] as number;
    expect(at(720, 1)).toBeGreaterThanOrEqual(1.5);
    expect(at(720, 1)).toBeLessThanOrEqual(2.5);
    expect(at(2160, 1)).toBe(2.5);
    expect(at(360, 1)).toBe(1.5);
    // lower render scale → fewer texels for the same display width → thinner in texels
    expect(at(1080, 0.5)).toBeLessThan(at(1080, 1));
  });

  it('halftone cell size is 6 display px at 720p', () => {
    const ht = ALL_PASSES.find((p) => p.id === 'halftone');
    expect(ht?.uniforms).toBeDefined();
    const u = ht!.uniforms!(ctx);
    expect(u['u_cell']).toBeCloseTo(6, 5);
    expect(u['u_angle']).toBeCloseTo((15 * Math.PI) / 180, 6);
    expect(u['u_maxDarken']).toBeCloseTo(0.25, 6);
  });
});

describe('STYLE_PRESETS', () => {
  it('paper-portrait is smooth → quantize(clean) → ink(paper) → grade', () => {
    const p = STYLE_PRESETS['paper-portrait'];
    expect(p.id).toBe('paper-portrait');
    expect(p.usesBackdrop).toBe(true);
    const ids = p.passes.map((x) => x.id);
    expect(ids).toEqual(['smooth-h', 'smooth-v', 'quantize-clean', 'ink-paper', 'grade-paper']);
  });

  it('comic is smooth → quantize(warm) → ink → halftone → backdrop → grade', () => {
    const p = STYLE_PRESETS.comic;
    expect(p.id).toBe('comic');
    expect(p.usesBackdrop).toBe(true);
    const ids = p.passes.map((x) => x.id);
    expect(ids).toEqual(['smooth-h', 'smooth-v', 'quantize-warm', 'ink-comic', 'halftone', 'backdrop', 'grade-comic']);
  });

  it('smoothing passes run at half resolution, the rest at full', () => {
    for (const preset of Object.values(STYLE_PRESETS)) {
      for (const pass of preset.passes) {
        if (pass.id.startsWith('smooth')) expect(pass.scale).toBe(0.5);
        else expect(pass.scale ?? 1).toBe(1);
      }
    }
  });

  it('every preset pass is part of ALL_PASSES (same object identity)', () => {
    for (const preset of Object.values(STYLE_PRESETS)) {
      for (const pass of preset.passes) expect(ALL_PASSES).toContain(pass);
    }
  });
});
