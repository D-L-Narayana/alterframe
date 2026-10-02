/**
 * `backdrop` — background replacement + cel shading for the masked / suit personas.
 *
 * Where the segmentation mask says background (mask < 0.5, feathered over `u_feather`
 * ≈ 8 px) the pixel is replaced by `u_backdrop` (W6's night city / warm paper). The person
 * keeps the quantised comic colour and receives a two-tone cel shade: pixels in the
 * darker luminance half are multiplied by `u_shadowTint` (a cool, slightly desaturating
 * multiplier) so flat regions get the "lit side / shadow side" look of the reference
 * illustration. A thin cool rim (`u_rimStrength`) along the person edge sells the cut-out
 * against the bright neon backdrop.
 *
 * Cost: 1 colour + 1 backdrop + 5 mask fetches.
 */
import type { PassContext, StylePass } from '../../types/render';
import { glsl, LUMA, PERSON_MASK, type Uniforms } from './glsl';

const FRAG = glsl`
uniform float u_feather;     // feather width in texels (8 px at 720p)
uniform vec3  u_shadowTint;  // multiplier applied to the shadow half of the person
uniform float u_shadowEdge;  // luminance where lit → shadow (0.45)
uniform float u_rimStrength; // 0..1 strength of the rim light at the silhouette
uniform vec3  u_rimColor;    // rim light colour
${LUMA}
${PERSON_MASK}
void main() {
  vec3 cel = texture(u_color, v_uv).rgb;
  vec3 bg = texture(u_backdrop, v_uv).rgb;
  float person = personMask(v_uv, u_feather);
  // Two-tone cel shade on the person.
  float l = luma(cel);
  float shadow = 1.0 - smoothstep(u_shadowEdge - 0.08, u_shadowEdge + 0.08, l);
  vec3 shaded = mix(cel, cel * u_shadowTint, shadow);
  // Rim: the feather band itself (person in 0.05..0.6) is where the outline lives.
  float rim = smoothstep(0.05, 0.35, person) * (1.0 - smoothstep(0.35, 0.7, person));
  shaded = mix(shaded, u_rimColor, rim * u_rimStrength);
  fragColor = vec4(mix(bg, shaded, person), 1.0);
}
`;

function uniforms(ctx: PassContext): Uniforms {
  const neon = ctx.scene.persona === 'masked';
  return {
    u_feather: 8 * (ctx.height / 720),
    u_shadowTint: [0.78, 0.8, 0.9],
    u_shadowEdge: 0.45,
    // The night city throws a blue rim; the warm paper of the suit persona a faint pink.
    u_rimStrength: neon ? 0.35 : 0.15,
    u_rimColor: neon ? [0.45, 0.6, 1.0] : [1.0, 0.55, 0.8],
  };
}

export const backdrop: StylePass = { id: 'backdrop', frag: FRAG, uniforms };
