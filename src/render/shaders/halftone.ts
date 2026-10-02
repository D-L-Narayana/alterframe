/**
 * `halftone` — screen-space dot pattern on mid-tones (comic only).
 *
 * A rotated (15°) grid of `u_cell` px cells; the dot radius grows as the pixel gets
 * darker (classic AM screening). A mid-tone window `midWeight` keeps highlights clean
 * and shadows flat (they are already dark). Darkening is capped at `u_maxDarken` (25 %)
 * so the pattern reads as print texture, not noise. The reference shows dots mainly on
 * walls and cloth, so the background (mask < 0.5) gets full strength and the person
 * `u_personWeight` (0.5).
 *
 * The dot edge is anti-aliased over ~1 px using the cell size, so the pattern does not
 * shimmer when the input moves. Cost: 1 colour + 1 mask fetch.
 */
import type { PassContext, StylePass } from '../../types/render';
import { glsl, LUMA, type Uniforms } from './glsl';

const FRAG = glsl`
uniform float u_cell;         // cell size in output px
uniform float u_angle;        // screen rotation in radians
uniform float u_maxDarken;    // 0..1 maximum darkening applied by a full dot
uniform float u_personWeight; // multiplier where the mask says "person"
${LUMA}
void main() {
  vec3 c = texture(u_color, v_uv).rgb;
  float l = luma(c);
  // Rotate pixel coordinates into the screen grid.
  vec2 p = v_uv * u_resolution;
  float ca = cos(u_angle), sa = sin(u_angle);
  vec2 g = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y) / u_cell;
  // Distance to the nearest cell centre in cell units (0..~0.71).
  float d = length(fract(g) - 0.5);
  // Dot radius: bigger where darker. 0.5 would fill the cell; stop at 0.46 so dots stay round.
  float r = mix(0.05, 0.46, 1.0 - l);
  float aa = 1.0 / u_cell; // ≈1 px anti-alias band in cell units
  float dot_ = 1.0 - smoothstep(r - aa, r + aa, d);
  // Mid-tone weight: 1 at l=0.5, fading to 0 at l=0.15 and l=0.85.
  float midWeight = 1.0 - smoothstep(0.0, 0.35, abs(l - 0.5));
  float person = texture(u_mask, v_uv).r;
  float w = mix(1.0, u_personWeight, smoothstep(0.4, 0.6, person));
  float darken = dot_ * midWeight * w * u_maxDarken;
  fragColor = vec4(c * (1.0 - darken), 1.0);
}
`;

function uniforms(ctx: PassContext): Uniforms {
  return {
    // 6 px at 720p, scaling with output height so dots stay the same relative size.
    u_cell: Math.max(3, 6 * (ctx.height / 720)),
    u_angle: (15 * Math.PI) / 180,
    u_maxDarken: 0.25,
    u_personWeight: 0.5,
  };
}

export const halftone: StylePass = { id: 'halftone', frag: FRAG, uniforms };
