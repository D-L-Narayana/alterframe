/**
 * `grade-paper` / `grade-comic` — final contrast, vignette and paper grain.
 *
 *  - Contrast: S-curve around 0.5 with gain `u_contrast` (paper 1.04, comic 1.15).
 *  - Vignette: smooth radial darkening from the centre, strength `u_vignette`
 *    (paper 0.08 — just enough to feel printed; comic 0.22).
 *  - Grain: ±`u_grain` (3 %) hash noise per pixel. For the paper variant the noise is
 *    static (true paper fibre does not move); for comic it is re-seeded per frame at
 *    ~12 Hz so recordings get a subtle film flicker without a 60 Hz buzz.
 *
 * Look: `look.grain` multiplies the grain amplitude (0 = clean, 1 = authored 3 %). Contrast,
 * vignette and lift are fixed per variant.
 *
 * Both variants are orientation-agnostic. Cost: 1 fetch.
 */
import type { PassContext, StylePass } from '../../types/render';
import { glsl, HASH, lookFactor, type Uniforms } from './glsl';

const FRAG = glsl`
uniform float u_contrast;  // contrast gain around mid grey
uniform float u_vignette;  // 0..1 corner darkening
uniform float u_grain;     // amplitude of grain (0.03 = ±3 %)
uniform float u_grainSeed; // changes per frame for animated grain, constant for static
uniform float u_lift;      // black lift (paper never goes fully black)
${HASH}
void main() {
  vec3 c = texture(u_color, v_uv).rgb;
  // Contrast around 0.5.
  c = (c - 0.5) * u_contrast + 0.5;
  // Vignette: radial falloff measured in the shorter screen axis so it stays round.
  vec2 q = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float vig = 1.0 - u_vignette * smoothstep(0.35, 1.1, length(q));
  c *= vig;
  // Paper grain.
  float n = hash12(floor(v_uv * u_resolution) + u_grainSeed) - 0.5;
  c += n * 2.0 * u_grain;
  c = mix(vec3(u_lift), vec3(1.0), c); // lift blacks slightly
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

function makeUniforms(variant: 'paper' | 'comic') {
  return (ctx: PassContext): Uniforms => ({
    u_contrast: variant === 'paper' ? 1.04 : 1.15,
    u_vignette: variant === 'paper' ? 0.08 : 0.22,
    // Authored amplitude × the look multiplier; 1 → 0.03 exactly.
    u_grain: 0.03 * lookFactor(ctx.look, 'grain'),
    // Static for paper; re-seeded at 12 Hz for comic (deterministic from time).
    u_grainSeed: variant === 'paper' ? 17.0 : Math.floor(ctx.time * 12) * 7.13,
    u_lift: variant === 'paper' ? 0.04 : 0.02,
  });
}

export const gradePaper: StylePass = { id: 'grade-paper', frag: FRAG, uniforms: makeUniforms('paper') };
export const gradeComic: StylePass = { id: 'grade-comic', frag: FRAG, uniforms: makeUniforms('comic') };
