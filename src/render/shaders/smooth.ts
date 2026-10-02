/**
 * `smooth-h` / `smooth-v` — two-pass separable bilateral blur at half resolution.
 *
 * Purpose: flatten skin, cloth and wall texture into cel-like regions while keeping
 * strong edges (hairline, jaw, hood) so later quantisation yields clean bands instead
 * of noisy speckle. A separable bilateral is not mathematically identical to the 2D
 * filter but is visually indistinguishable here and 9+9 taps instead of 81.
 *
 * Both passes run at `scale: 0.5`; the first one reads `u_video` directly (the core
 * binds the video as `u_color` for the first pass, but we sample `u_video` explicitly
 * so the pass also works when placed later in a chain), the second reads `u_color`.
 *
 * Cost: 9 texture fetches per pixel per pass at quarter pixel count ≈ 4.5 full-res
 * fetches per output pixel total.
 */
import type { PassContext, StylePass } from '../../types/render';
import { glsl, pxScale, type Uniforms } from './glsl';

const SMOOTH_SCALE = 0.5;

/**
 * Builds the body for one direction. `dir` is a swizzle for the step vector.
 * `src` is which sampler to blur.
 */
function body(dir: 'x' | 'y', src: 'u_video' | 'u_color'): string {
  const step = dir === 'x' ? 'vec2(u_texel.x * u_step, 0.0)' : 'vec2(0.0, u_texel.y * u_step)';
  return glsl`
uniform float u_step;      // tap spacing in texels (≈1 at 360p-half-res, grows with resolution)
uniform float u_rangeSigma; // colour-distance sigma: smaller = keeps more edges
void main() {
  vec2 d = ${step};
  vec3 center = texture(${src}, v_uv).rgb;
  // Spatial gaussian weights for offsets 0..4 (sigma ≈ 2 taps).
  const float w[5] = float[5](0.2042, 0.1802, 0.1238, 0.0663, 0.0276);
  vec3 acc = center * w[0];
  float wsum = w[0];
  float invR = 1.0 / (2.0 * u_rangeSigma * u_rangeSigma);
  for (int i = 1; i <= 4; i++) {
    vec2 o = d * float(i);
    vec3 a = texture(${src}, v_uv + o).rgb;
    vec3 b = texture(${src}, v_uv - o).rgb;
    // Range weight from squared colour distance: pixels across an edge barely contribute.
    float wa = w[i] * exp(-dot(a - center, a - center) * invR);
    float wb = w[i] * exp(-dot(b - center, b - center) * invR);
    acc += a * wa + b * wb;
    wsum += wa + wb;
  }
  fragColor = vec4(acc / wsum, 1.0);
}
`;
}

function uniforms(ctx: PassContext): Uniforms {
  return {
    // Authored for a 360-px-tall half-res buffer; scale so the blur covers the same
    // fraction of the face at any resolution (never below 1 texel).
    u_step: Math.max(1, pxScale(ctx, SMOOTH_SCALE)),
    u_rangeSigma: 0.14,
  };
}

export const smoothH: StylePass = { id: 'smooth-h', frag: body('x', 'u_video'), scale: SMOOTH_SCALE, uniforms };
export const smoothV: StylePass = { id: 'smooth-v', frag: body('y', 'u_color'), scale: SMOOTH_SCALE, uniforms };
