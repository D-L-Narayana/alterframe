import { describe, it, expect } from 'vitest';
import { FRAG_PRELUDE, VERTEX_SOURCE, buildFragmentSource, PRELUDE_UNIFORMS } from '../../../src/render/core/prelude';
import { passthrough, solid } from '../../../src/render/core/passes';
import { classifyUniform } from '../../../src/render/core/uniforms';
import { DEFAULT_LOOK, DEFAULT_QUALITY } from '../../../src/types/render';

describe('GLSL prelude', () => {
  it('declares every sampler and uniform promised by src/types/render.ts', () => {
    for (const name of ['u_color', 'u_video', 'u_mask', 'u_backdrop']) {
      expect(FRAG_PRELUDE).toMatch(new RegExp(`uniform\\s+sampler2D\\s+${name};`));
    }
    expect(FRAG_PRELUDE).toMatch(/uniform\s+vec2\s+u_resolution;/);
    expect(FRAG_PRELUDE).toMatch(/uniform\s+vec2\s+u_texel;/);
    expect(FRAG_PRELUDE).toMatch(/uniform\s+float\s+u_time;/);
    expect(FRAG_PRELUDE).toMatch(/in\s+vec2\s+v_uv;/);
    expect(FRAG_PRELUDE).toMatch(/out\s+vec4\s+fragColor;/);
    expect(PRELUDE_UNIFORMS).toEqual(['u_color', 'u_video', 'u_mask', 'u_backdrop', 'u_resolution', 'u_texel', 'u_time']);
  });

  it('starts with #version 300 es on the very first line and sets a precision', () => {
    expect(FRAG_PRELUDE.startsWith('#version 300 es\n')).toBe(true);
    expect(FRAG_PRELUDE).toMatch(/precision\s+(highp|mediump)\s+float;/);
    expect(VERTEX_SOURCE.startsWith('#version 300 es\n')).toBe(true);
  });

  it('builds a fragment shader = prelude + body, and refuses a body with its own #version', () => {
    const src = buildFragmentSource('void main(){ fragColor = vec4(1.0); }');
    expect(src.startsWith(FRAG_PRELUDE)).toBe(true);
    expect(src).toContain('fragColor = vec4(1.0)');
    expect(() => buildFragmentSource('#version 300 es\nvoid main(){}')).toThrow(/#version/);
  });

  it('vertex shader emits v_uv with (0,0) at display top-left for intermediate targets', () => {
    // Convention documented in fit.ts: v_uv = clip * 0.5 + 0.5 — texel row 0 (clip y = -1) is display top.
    expect(VERTEX_SOURCE).toMatch(/v_uv\s*=/);
    expect(VERTEX_SOURCE).toMatch(/0\.5/);
  });
});

describe('built-in passes', () => {
  it('passthrough samples u_color only', () => {
    expect(passthrough.id).toBe('passthrough');
    expect(passthrough.frag).toContain('u_color');
    expect(passthrough.frag).not.toContain('#version');
    expect(passthrough.frag).toContain('fragColor');
  });

  it('solid(color) carries its colour through uniforms(ctx) and has a stable id per colour', () => {
    const p = solid([1, 0, 0, 1]);
    expect(p.id).toMatch(/^solid/);
    expect(p.frag).toContain('u_solidColor');
    expect(p.uniforms).toBeTypeOf('function');
    const u = p.uniforms!({ time: 0, width: 1, height: 1, scene: { base: 'live', persona: 'portrait', hudTint: 'white' }, quality: { ...DEFAULT_QUALITY }, look: { ...DEFAULT_LOOK } });
    expect(u['u_solidColor']).toEqual([1, 0, 0, 1]);
    expect(solid([1, 0, 0, 1]).id).toBe(p.id);
    expect(solid([0, 1, 0, 1]).id).not.toBe(p.id);
  });

  it('solid accepts rgb and fills alpha with 1', () => {
    const p = solid([0.2, 0.4, 0.6]);
    const u = p.uniforms!({ time: 0, width: 1, height: 1, scene: { base: 'live', persona: 'portrait', hudTint: 'white' }, quality: { ...DEFAULT_QUALITY }, look: { ...DEFAULT_LOOK } });
    expect(u['u_solidColor']).toEqual([0.2, 0.4, 0.6, 1]);
  });
});

describe('uniform value classification', () => {
  it('maps plain numbers and tuples to float/vec setters', () => {
    expect(classifyUniform(1)).toBe('1f');
    expect(classifyUniform([1, 2])).toBe('2f');
    expect(classifyUniform([1, 2, 3])).toBe('3f');
    expect(classifyUniform([1, 2, 3, 4])).toBe('4f');
  });

  it('maps Float32Array by length: 1-4 vector, 9 mat3, 16 mat4, otherwise float array', () => {
    expect(classifyUniform(new Float32Array(1))).toBe('1f');
    expect(classifyUniform(new Float32Array(2))).toBe('2f');
    expect(classifyUniform(new Float32Array(3))).toBe('3f');
    expect(classifyUniform(new Float32Array(4))).toBe('4f');
    expect(classifyUniform(new Float32Array(9))).toBe('mat3');
    expect(classifyUniform(new Float32Array(16))).toBe('mat4');
    expect(classifyUniform(new Float32Array(7))).toBe('1fv');
    expect(classifyUniform(new Float32Array(0))).toBe('1fv');
  });
});
