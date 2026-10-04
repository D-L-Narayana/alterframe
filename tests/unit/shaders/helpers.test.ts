import { describe, it, expect } from 'vitest';
import { hexToRgb, pxScale, inkWidthTexels, glslUniformDecls } from '../../../src/render/shaders';
import { DEFAULT_LOOK, DEFAULT_QUALITY } from '../../../src/types/render';
import { DEFAULT_SCENE } from '../../../src/types/scene';

const ctx = { time: 0, width: 1280, height: 720, scene: DEFAULT_SCENE, quality: DEFAULT_QUALITY, look: DEFAULT_LOOK };

describe('shader helpers', () => {
  it('hexToRgb converts persona tokens to 0..1 triples', () => {
    expect(hexToRgb('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    const [r, g, b] = hexToRgb('#ff4fb6');
    expect(r).toBeCloseTo(1, 5);
    expect(g).toBeCloseTo(0x4f / 255, 5);
    expect(b).toBeCloseTo(0xb6 / 255, 5);
  });

  it('pxScale is 1 at 720p output; a half-res pass sees height 360 and normalises back to 1; clamped', () => {
    expect(pxScale(ctx)).toBe(1);
    expect(pxScale({ ...ctx, height: 360 }, 0.5)).toBe(1);
    expect(pxScale({ ...ctx, height: 540 }, 0.5)).toBe(1.5);
    expect(pxScale({ ...ctx, height: 20 })).toBe(0.25);
    expect(pxScale({ ...ctx, height: 10000 })).toBe(4);
  });

  it('inkWidthTexels is 2 texels at 720p full scale', () => {
    expect(inkWidthTexels(ctx)).toBeCloseTo(2, 6);
  });

  it('glslUniformDecls parses declarations and ignores non-uniform lines', () => {
    const src = `
uniform float u_a; // comment
uniform vec3  u_b;
  uniform vec2 u_c;
float notAUniform(float x) { return x; }
`;
    expect(glslUniformDecls(src)).toEqual({ u_a: 'float', u_b: 'vec3', u_c: 'vec2' });
  });
});
