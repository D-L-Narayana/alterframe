/**
 * `quantize-clean` / `quantize-warm` — luminance quantisation into cel bands.
 *
 * Luminance of the smoothed image is snapped to `u_bands` (6) levels with a soft
 * transition (`u_soft`) so band borders don't shimmer frame to frame. Hue is kept by
 * scaling RGB with the new/old luminance ratio, then chroma is boosted ×1.25 (the
 * reference illustration is noticeably more saturated than the camera).
 *
 * Variants:
 *  - clean (paper-portrait): neutral, slightly lifted whites, so the person reads as flat
 *    colour on white paper.
 *  - warm (comic): warm multiplier + lifted shadows toward a warm brown, matching the
 *    sunlit, orange-leaning comic base in the reference.
 *
 * Cost: 1 fetch per pixel.
 */
import type { PassContext, StylePass } from '../../types/render';
import { glsl, LUMA, SATURATE, type Uniforms } from './glsl';

const FRAG = glsl`
uniform float u_bands;      // number of luminance levels (5–6)
uniform float u_soft;       // half-width of the soft threshold in band units (0 = hard)
uniform float u_saturation; // chroma multiplier around luminance
uniform vec3  u_tint;       // per-channel multiplier (1,1,1 = clean)
uniform vec3  u_shadowLift; // colour added in the darkest band (warm variants lift shadows)
${LUMA}
${SATURATE}

// Snap l to the centre of its band, blending across the band border over ±u_soft.
// Bands are [k, k+1)/u_bands with centre (k+0.5)/u_bands. Shifting by half a band puts the
// borders at fract(x') == 0.5 so a single smoothstep handles the soft transition.
float quantizeLuma(float l) {
  float x = l * u_bands - 0.5;
  float k = floor(x);
  float t = smoothstep(0.5 - u_soft, 0.5 + u_soft, fract(x)); // 0 in band k, 1 once over the border
  return clamp((k + 0.5 + t) / u_bands, 0.5 / u_bands, 1.0 - 0.5 / u_bands);
}

void main() {
  vec3 c = texture(u_color, v_uv).rgb;
  float l = max(luma(c), 1e-4);
  float lq = quantizeLuma(l);
  // Keep chroma, move luminance: scale RGB by the band ratio.
  vec3 q = clamp(c * (lq / l), 0.0, 1.0);
  q = saturate3(q, u_saturation);
  q *= u_tint;
  // Lift the darkest band toward a tinted shadow colour instead of crushing to black.
  float shadow = 1.0 - smoothstep(0.0, 1.5 / u_bands, lq);
  q += u_shadowLift * shadow;
  fragColor = vec4(clamp(q, 0.0, 1.0), 1.0);
}
`;

function makeUniforms(variant: 'clean' | 'warm') {
  return (_ctx: PassContext): Uniforms => ({
    u_bands: 6,
    u_soft: 0.3, // softer band borders: a lighting gradient across a face no longer splits it with a hard seam
    u_saturation: 1.25,
    u_tint: variant === 'warm' ? [1.07, 1.0, 0.9] : [1.0, 1.0, 1.0],
    u_shadowLift: variant === 'warm' ? [0.08, 0.04, 0.02] : [0.0, 0.0, 0.0],
  });
}

export const quantizeClean: StylePass = { id: 'quantize-clean', frag: FRAG, uniforms: makeUniforms('clean') };
export const quantizeWarm: StylePass = { id: 'quantize-warm', frag: FRAG, uniforms: makeUniforms('warm') };
