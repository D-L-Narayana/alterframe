import { describe, it, expect } from 'vitest';
import {
  ALL_PASSES, smoothH, smoothV, quantizeClean, quantizeWarm, inkPaper, inkComic, halftone, backdrop, gradePaper, gradeComic,
  hexToRgb, glslUniformDecls,
} from '../../../src/render/shaders';
import type { LookSettings, PassContext, StylePass, UniformValue } from '../../../src/types/render';
import { DEFAULT_LOOK, DEFAULT_QUALITY } from '../../../src/types/render';
import { PERSONA_TOKENS } from '../../../src/types/persona';
import { DEFAULT_SCENE } from '../../../src/types/scene';

/**
 * Look tuning must be invisible at defaults: with `DEFAULT_LOOK` every pass has to hand the
 * core exactly the v0.1 uniform values (bit-identical render, visual baselines untouched).
 * Away from the defaults each look field moves exactly one knob in the documented direction.
 */

/** 720p output, full render scale, persona portrait, t = 1.5 s — the context the v0.1 constants were authored at. */
const base: PassContext = { time: 1.5, width: 1280, height: 720, scene: DEFAULT_SCENE, quality: DEFAULT_QUALITY, look: DEFAULT_LOOK };
/** Half-resolution passes see their own output size (the core applies `pass.scale` before calling `uniforms()`). */
const half: PassContext = { ...base, width: 640, height: 360 };
const masked: PassContext = { ...base, scene: { ...DEFAULT_SCENE, persona: 'masked' } };
const suit: PassContext = { ...base, scene: { ...DEFAULT_SCENE, persona: 'suit' } };

const withLook = (ctx: PassContext, look: Partial<LookSettings>): PassContext => ({ ...ctx, look: { ...DEFAULT_LOOK, ...look } });
const uniformsOf = (pass: StylePass, ctx: PassContext): Record<string, UniformValue> => pass.uniforms?.(ctx) ?? {};
const num = (pass: StylePass, ctx: PassContext, name: string): number => {
  const v = uniformsOf(pass, ctx)[name];
  if (typeof v !== 'number') throw new Error(`${pass.id}.${name} is not a float uniform`);
  return v;
};
/** The uniform record minus the given keys — for "everything else is unchanged" assertions. */
const omit = (u: Record<string, UniformValue>, keys: readonly string[]): Record<string, UniformValue> =>
  Object.fromEntries(Object.entries(u).filter(([k]) => !keys.includes(k)));

const INK_RGB = hexToRgb(PERSONA_TOKENS.ink);
const DEG15 = (15 * Math.PI) / 180;

/** The v0.1 values, written out literally (the only arithmetic is the same expression the shader files use). */
const GOLDEN: ReadonlyArray<{ id: string; pass: StylePass; ctx: PassContext; expected: Record<string, UniformValue> }> = [
  { id: 'smooth-h @ half res', pass: smoothH, ctx: half, expected: { u_step: 1, u_rangeSigma: 0.14 } },
  { id: 'smooth-v @ half res', pass: smoothV, ctx: half, expected: { u_step: 1, u_rangeSigma: 0.14 } },
  { id: 'quantize-clean', pass: quantizeClean, ctx: base, expected: { u_bands: 6, u_soft: 0.3, u_saturation: 1.25, u_tint: [1.0, 1.0, 1.0], u_shadowLift: [0.0, 0.0, 0.0] } },
  { id: 'quantize-warm', pass: quantizeWarm, ctx: base, expected: { u_bands: 6, u_soft: 0.3, u_saturation: 1.25, u_tint: [1.07, 1.0, 0.9], u_shadowLift: [0.08, 0.04, 0.02] } },
  { id: 'ink-paper', pass: inkPaper, ctx: base, expected: { u_inkWidth: 2, u_edgeLo: 0.2, u_edgeHi: 0.5, u_silhouette: 0.85, u_inkColor: INK_RGB, u_feather: 6 } },
  { id: 'ink-comic', pass: inkComic, ctx: base, expected: { u_inkWidth: 2, u_edgeLo: 0.2, u_edgeHi: 0.5, u_silhouette: 0.85, u_inkColor: INK_RGB } },
  { id: 'halftone', pass: halftone, ctx: base, expected: { u_cell: 6, u_angle: DEG15, u_maxDarken: 0.25, u_personWeight: 0.5 } },
  { id: 'backdrop (masked → neon rim)', pass: backdrop, ctx: masked, expected: { u_feather: 8, u_shadowTint: [0.78, 0.8, 0.9], u_shadowEdge: 0.45, u_rimStrength: 0.35, u_rimColor: [0.45, 0.6, 1.0] } },
  { id: 'backdrop (suit → pink rim)', pass: backdrop, ctx: suit, expected: { u_feather: 8, u_shadowTint: [0.78, 0.8, 0.9], u_shadowEdge: 0.45, u_rimStrength: 0.15, u_rimColor: [1.0, 0.55, 0.8] } },
  { id: 'grade-paper', pass: gradePaper, ctx: base, expected: { u_contrast: 1.04, u_vignette: 0.08, u_grain: 0.03, u_grainSeed: 17.0, u_lift: 0.04 } },
  { id: 'grade-comic', pass: gradeComic, ctx: base, expected: { u_contrast: 1.15, u_vignette: 0.22, u_grain: 0.03, u_grainSeed: Math.floor(1.5 * 12) * 7.13, u_lift: 0.02 } },
];

describe('golden table: DEFAULT_LOOK reproduces the v0.1 uniforms exactly', () => {
  it('the contract defaults are the neutral multipliers this table assumes', () => {
    expect(DEFAULT_LOOK).toEqual({ inkWidth: 1, inkThreshold: 1, halftone: 1, saturation: 1, bands: 6, grain: 1, overlayStrength: 1 });
  });

  it('every shipped pass has a golden row (no pass can skip the identity check)', () => {
    expect(new Set(GOLDEN.map((g) => g.pass.id))).toEqual(new Set(ALL_PASSES.map((p) => p.id)));
  });

  it.each(GOLDEN)('$id', ({ pass, ctx, expected }) => {
    // toEqual compares numbers with Object.is → exact bits, no tolerance.
    expect(uniformsOf(pass, ctx)).toEqual(expected);
  });

  it('a fresh copy of DEFAULT_LOOK gives the same record as the shared constant', () => {
    for (const { pass, ctx } of GOLDEN) expect(uniformsOf(pass, { ...ctx, look: { ...DEFAULT_LOOK } })).toEqual(uniformsOf(pass, ctx));
  });
});

const INKS = [inkPaper, inkComic];
const QUANTIZERS = [quantizeClean, quantizeWarm];
const GRADES = [gradePaper, gradeComic];
const LOOK_KEYS = ['inkWidth', 'inkThreshold', 'halftone', 'saturation', 'bands', 'grain', 'overlayStrength'] as const;
/** Every look field pushed to an extreme at once. */
const EXTREME: LookSettings = { inkWidth: 3, inkThreshold: 0.25, halftone: 0, saturation: 2, bands: 3, grain: 3, overlayStrength: 0 };

const isIncreasing = (xs: number[]): boolean => xs.every((x, i) => i === 0 || x > (xs[i - 1] as number));

describe('look → ink passes', () => {
  it.each(INKS)('$id: inkWidth multiplies u_inkWidth after the display-px clamp (2 → 4 texels at 720p, 0.5 → 1, 3 → 6)', (pass) => {
    expect(num(pass, withLook(base, { inkWidth: 2 }), 'u_inkWidth')).toBe(4);
    expect(num(pass, withLook(base, { inkWidth: 0.5 }), 'u_inkWidth')).toBe(1);
    expect(num(pass, withLook(base, { inkWidth: 3 }), 'u_inkWidth')).toBe(6);
    // 2160p: the authored width clamps at 2.5 display px, then the multiplier applies → 7.5.
    expect(num(pass, withLook({ ...base, width: 3840, height: 2160 }, { inkWidth: 3 }), 'u_inkWidth')).toBeCloseTo(7.5, 9);
    // 720p display at renderScale 0.5 (pass height 360): still 2 display px → 1 texel, × 2.
    expect(num(pass, withLook({ ...base, width: 640, height: 360, quality: { ...DEFAULT_QUALITY, renderScale: 0.5 } }, { inkWidth: 2 }), 'u_inkWidth')).toBeCloseTo(2, 9);
    // 540p display at renderScale 0.5 (pass height 270): 1.5 display px (clamp floor) → 0.75 texels, × 2.
    expect(num(pass, withLook({ ...base, width: 480, height: 270, quality: { ...DEFAULT_QUALITY, renderScale: 0.5 } }, { inkWidth: 2 }), 'u_inkWidth')).toBeCloseTo(1.5, 9);
  });

  it.each(INKS)('$id: u_inkWidth grows strictly with inkWidth', (pass) => {
    expect(isIncreasing([0.25, 0.5, 1, 1.5, 2, 3].map((w) => num(pass, withLook(base, { inkWidth: w }), 'u_inkWidth')))).toBe(true);
  });

  it.each(INKS)('$id: inkThreshold scales both Sobel thresholds by the same factor, lo stays below hi', (pass) => {
    for (const t of [0.25, 0.5, 1, 2, 3]) {
      const ctx = withLook(base, { inkThreshold: t });
      const lo = num(pass, ctx, 'u_edgeLo');
      const hi = num(pass, ctx, 'u_edgeHi');
      expect(lo).toBeCloseTo(0.2 * t, 12);
      expect(hi).toBeCloseTo(0.5 * t, 12);
      expect(lo).toBeLessThan(hi);
    }
    expect(isIncreasing([0.25, 0.5, 1, 2, 3].map((t) => num(pass, withLook(base, { inkThreshold: t }), 'u_edgeLo')))).toBe(true);
  });

  it.each(INKS)('$id: inkThreshold 0 or negative still yields 0 < lo < hi (smoothstep with lo == hi is undefined in GLSL)', (pass) => {
    for (const t of [0, -1]) {
      const ctx = withLook(base, { inkThreshold: t });
      const lo = num(pass, ctx, 'u_edgeLo');
      const hi = num(pass, ctx, 'u_edgeHi');
      expect(lo).toBeGreaterThan(0);
      expect(lo).toBeLessThan(hi);
    }
  });

  it.each(INKS)('$id: the look touches only u_inkWidth / u_edgeLo / u_edgeHi', (pass) => {
    const moved = ['u_inkWidth', 'u_edgeLo', 'u_edgeHi'];
    expect(omit(uniformsOf(pass, { ...base, look: EXTREME }), moved)).toEqual(omit(uniformsOf(pass, base), moved));
  });
});

describe('look → quantize passes', () => {
  it.each(QUANTIZERS)('$id: u_bands = clamp(round(bands), 3, 8)', (pass) => {
    const bands = (b: number) => num(pass, withLook(base, { bands: b }), 'u_bands');
    expect(bands(1)).toBe(3);
    expect(bands(2.9)).toBe(3);
    expect(bands(3)).toBe(3);
    expect(bands(5.4)).toBe(5);
    expect(bands(5.6)).toBe(6);
    expect(bands(6)).toBe(6);
    expect(bands(8)).toBe(8);
    expect(bands(8.4)).toBe(8);
    expect(bands(12)).toBe(8);
    for (const b of [3, 4, 5, 6, 7, 8]) expect(Number.isInteger(bands(b))).toBe(true);
  });

  it.each(QUANTIZERS)('$id: saturation multiplies the 1.25 chroma boost (0 → grey, 2 → 2.5)', (pass) => {
    const sat = (s: number) => num(pass, withLook(base, { saturation: s }), 'u_saturation');
    expect(sat(0)).toBe(0);
    expect(sat(0.5)).toBe(0.625);
    expect(sat(2)).toBe(2.5);
    expect(isIncreasing([0, 0.5, 1, 1.5, 2].map(sat))).toBe(true);
  });

  it.each(QUANTIZERS)('$id: the look touches only u_bands / u_saturation (soft edge, tint and shadow lift are fixed)', (pass) => {
    const moved = ['u_bands', 'u_saturation'];
    expect(omit(uniformsOf(pass, { ...base, look: EXTREME }), moved)).toEqual(omit(uniformsOf(pass, base), moved));
  });
});

describe('look → halftone', () => {
  it('halftone multiplies the 25 % darkening cap (0 disables the dots, 2 → 0.5)', () => {
    const cap = (h: number) => num(halftone, withLook(base, { halftone: h }), 'u_maxDarken');
    expect(cap(0)).toBe(0);
    expect(cap(0.5)).toBe(0.125);
    expect(cap(2)).toBe(0.5);
    expect(isIncreasing([0, 0.5, 1, 1.5, 2].map(cap))).toBe(true);
  });

  it('the look touches only u_maxDarken (cell, angle and person weight are fixed)', () => {
    expect(omit(uniformsOf(halftone, { ...base, look: EXTREME }), ['u_maxDarken'])).toEqual(omit(uniformsOf(halftone, base), ['u_maxDarken']));
  });
});

describe('look → grade passes', () => {
  it.each(GRADES)('$id: grain multiplies the 3 % amplitude (0 → none, 2 → 0.06, 3 → 0.09)', (pass) => {
    const grain = (g: number) => num(pass, withLook(base, { grain: g }), 'u_grain');
    expect(grain(0)).toBe(0);
    expect(grain(2)).toBe(0.06);
    expect(grain(3)).toBeCloseTo(0.09, 12);
    expect(isIncreasing([0, 0.5, 1, 2, 3].map(grain))).toBe(true);
  });

  it.each(GRADES)('$id: the look touches only u_grain (contrast, vignette, seed and lift are fixed per variant)', (pass) => {
    expect(omit(uniformsOf(pass, { ...base, look: EXTREME }), ['u_grain'])).toEqual(omit(uniformsOf(pass, base), ['u_grain']));
  });
});

describe('look fields that are not shader knobs', () => {
  it('overlayStrength (persona overlay alpha) changes no pass uniform', () => {
    for (const pass of ALL_PASSES) {
      expect(uniformsOf(pass, withLook(masked, { overlayStrength: 0 })), pass.id).toEqual(uniformsOf(pass, masked));
    }
  });

  it.each([smoothH, smoothV, backdrop])('$id ignores the look entirely', (pass) => {
    const ctx = pass.scale === 0.5 ? half : masked;
    expect(uniformsOf(pass, { ...ctx, look: EXTREME })).toEqual(uniformsOf(pass, ctx));
  });
});

describe('look robustness', () => {
  it.each(LOOK_KEYS)('a non-finite %s falls back to its default (NaN would poison the frame)', (key) => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const look: LookSettings = { ...DEFAULT_LOOK };
      look[key] = bad;
      for (const pass of ALL_PASSES) {
        expect(uniformsOf(pass, { ...masked, look }), `${pass.id} ${key}=${bad}`).toEqual(uniformsOf(pass, masked));
      }
    }
  });

  it('negative multipliers clamp to the physical floor: no negative width, darkening, saturation or grain', () => {
    expect(num(inkPaper, withLook(base, { inkWidth: -1 }), 'u_inkWidth')).toBe(0);
    expect(num(halftone, withLook(base, { halftone: -1 }), 'u_maxDarken')).toBe(0);
    expect(num(quantizeWarm, withLook(base, { saturation: -1 }), 'u_saturation')).toBe(0);
    expect(num(gradeComic, withLook(base, { grain: -1 }), 'u_grain')).toBe(0);
  });
});

describe('declared-vs-provided uniform parity holds for every look', () => {
  const looks: Array<[string, LookSettings]> = [
    ['default', DEFAULT_LOOK],
    ['extreme', EXTREME],
    ['zeroes', { inkWidth: 0, inkThreshold: 0, halftone: 0, saturation: 0, bands: 0, grain: 0, overlayStrength: 0 }],
  ];
  const glslTypeOf = (v: UniformValue): string => {
    if (typeof v === 'number') return 'float';
    if (v instanceof Float32Array) return 'float[]';
    return ['', '', 'vec2', 'vec3', 'vec4'][v.length] ?? 'unknown';
  };

  it.each(ALL_PASSES.map((p) => [p.id, p] as const))('%s', (_id, pass) => {
    const decls = glslUniformDecls(pass.frag);
    for (const [label, look] of looks) {
      const provided = uniformsOf(pass, { ...masked, look });
      expect(Object.keys(provided).sort(), label).toEqual(Object.keys(decls).sort());
      for (const [name, value] of Object.entries(provided)) {
        expect(glslTypeOf(value), `${label} ${name}`).toBe(decls[name]);
        const nums = typeof value === 'number' ? [value] : Array.from(value);
        for (const n of nums) expect(Number.isFinite(n), `${label} ${name}`).toBe(true);
      }
    }
  });
});
