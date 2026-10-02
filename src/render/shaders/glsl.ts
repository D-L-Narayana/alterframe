/**
 * Shared GLSL ES 3.00 building blocks for the stylization passes (W5).
 *
 * Every pass body is a string that the core (W4) prepends with the prelude described in
 * `src/types/render.ts`. The bodies here therefore never declare `#version`, precision,
 * `v_uv`, `fragColor` or the shared samplers/uniforms — only pass-specific uniforms,
 * helper functions and `main()`.
 *
 * Orientation: all passes are written to be orientation-agnostic (no logic depends on
 * whether v_uv.y = 0 is the top or bottom row), so they work regardless of how the core
 * lays out its ping-pong framebuffers. Screen-space patterns (halftone, grain) only need
 * pixel coordinates, which they derive from `v_uv * u_resolution`.
 */

import type { PassContext, UniformValue } from '../../types/render';

/** Identity template tag; exists so editors can syntax-highlight GLSL and we can grep for shader code. */
export const glsl = (strings: TemplateStringsArray, ...values: Array<string | number>): string =>
  strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), '');

/**
 * The prelude the core is contracted to prepend (mirrors the comment block in
 * src/types/render.ts). Exported for the dev harness / standalone compile checks so the
 * shaders are verified against exactly the declarations they will meet at runtime.
 */
export const PRELUDE = glsl`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_color;
uniform sampler2D u_video;
uniform sampler2D u_mask;
uniform sampler2D u_backdrop;
uniform vec2 u_resolution;
uniform vec2 u_texel;
uniform float u_time;
out vec4 fragColor;
`;

/** Rec.709 luminance. */
export const LUMA = glsl`
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/**
 * Cheap, well-distributed 2D → 1D hash (Dave Hoskins style). Used for paper grain and
 * dither. Deterministic per pixel + time so recordings look stable frame to frame.
 */
export const HASH = glsl`
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * Person probability with a soft edge. The segmentation mask is low resolution (≈256²)
 * so we average five taps spread by `featherPx` (in output pixels) to grow a feather
 * band, then sharpen with a smoothstep around 0.5. Returns 0 (background) … 1 (person).
 */
export const PERSON_MASK = glsl`
float personMask(vec2 uv, float featherPx) {
  vec2 f = u_texel * featherPx;
  float m = texture(u_mask, uv).r * 0.4;
  m += texture(u_mask, uv + vec2( f.x, 0.0)).r * 0.15;
  m += texture(u_mask, uv + vec2(-f.x, 0.0)).r * 0.15;
  m += texture(u_mask, uv + vec2(0.0,  f.y)).r * 0.15;
  m += texture(u_mask, uv + vec2(0.0, -f.y)).r * 0.15;
  return smoothstep(0.35, 0.65, m);
}
`;

/**
 * Saturation adjustment around luminance (keeps hue, boosts chroma). `s` = 1 is identity.
 */
export const SATURATE = glsl`
vec3 saturate3(vec3 c, float s) { return clamp(mix(vec3(luma(c)), c, s), 0.0, 1.0); }
`;

/** Parse `uniform <type> <name>;` declarations from a pass body → { name: glslType }. */
export function glslUniformDecls(frag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s*uniform\s+(\w+)\s+(\w+)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(frag)) !== null) {
    const type = m[1];
    const name = m[2];
    if (type !== undefined && name !== undefined) out[name] = type;
  }
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * "How many 720p-pixels is one texel of this pass". Pass kernels are authored at 720p
 * output and scaled by this so the look is resolution independent.
 *
 * The core (W4 `PassRunner.run`) calls `uniforms()` with `ctx.width/height` set to the
 * PASS output size (already multiplied by `pass.scale`). A pass with `scale: 0.5` therefore
 * sees 360 at 720p output; passing its own `passScale` normalises that back to 1.
 */
export function pxScale(ctx: PassContext, passScale = 1): number {
  return clamp(ctx.height / (720 * passScale), 0.25, 4);
}

/**
 * Ink line thickness in *pass texels*: 2 px at 720p, clamped to the contract's
 * 1.5–2.5 display-px range, then expressed in the pass' own texels (renderScale < 1
 * means fewer texels cover the same display width, so the texel width shrinks).
 */
export function inkWidthTexels(ctx: PassContext): number {
  const displayPx = clamp(2.0 * (ctx.height / ctx.quality.renderScale) / 720, 1.5, 2.5);
  return displayPx * ctx.quality.renderScale;
}

export type Uniforms = Record<string, UniformValue>;
