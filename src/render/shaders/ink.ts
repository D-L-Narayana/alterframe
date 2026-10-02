/**
 * `ink-paper` / `ink-comic` — Sobel edge detection → black ink lines.
 *
 * Edge source: luminance of the display-space VIDEO (`u_video`), not of `u_color`.
 * `u_color` at this point is the QUANTIZED cel image, and every luminance-band border in it
 * is a hard step — using it for edge detection drew a "contour map" of lines across faces
 * (found at integration on real footage). The video has sensor noise instead, which the
 * Sobel tap spread (≥ 1.5 px) plus the `u_edgeLo..u_edgeHi` threshold removes while real
 * outlines (jaw, hairline, lips, hood, door frame) stay. A second Sobel on the segmentation
 * mask adds a confident silhouette line around the person (strong outline in the reference).
 *
 * Thickness: the Sobel taps are spread by `u_inkWidth * 0.75` texels. Spreading the taps
 * widens the gradient response, which is what makes the line thicker; `u_inkWidth` is
 * 2 px at 720p clamped to 1.5–2.5 display px (see `inkWidthTexels`).
 *
 * Variants:
 *  - paper (paper-portrait): lines are drawn EVERYWHERE (room line-art), colour is kept
 *    only where the mask says "person"; background becomes `u_backdrop` (paper, W6).
 *  - comic: lines over the cel colour everywhere; does not read `u_backdrop` so the same
 *    pass is valid for the full-frame comic base layer.
 *
 * Cost: 9 taps × 2 samplers for the Sobel + 9 mask taps (+ 5 mask taps + 1 backdrop for
 * paper) ≈ 27–33 fetches per pixel. Still cheap at 720p.
 */
import type { PassContext, StylePass } from '../../types/render';
import { PERSONA_TOKENS } from '../../types/persona';
import { glsl, LUMA, PERSON_MASK, inkWidthTexels, type Uniforms } from './glsl';

const INK_RGB = hexToRgb(PERSONA_TOKENS.ink);

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const SOBEL = glsl`
// Luminance used for edge detection: the display-space video (see header comment), pre-blurred
// with a symmetric 3×3 tent (four linear-filtered taps at the texel corners) so sensor/codec noise
// is halved before the Sobel while the blur stays centred (no half-texel line shift).
float edgeLuma(vec2 uv) {
  vec2 h = 0.5 * u_texel;
  return 0.25 * (luma(texture(u_video, uv + vec2( h.x,  h.y)).rgb) + luma(texture(u_video, uv + vec2(-h.x,  h.y)).rgb)
               + luma(texture(u_video, uv + vec2( h.x, -h.y)).rgb) + luma(texture(u_video, uv + vec2(-h.x, -h.y)).rgb));
}

// 3×3 Sobel magnitude of f sampled with tap spacing s (texels). Returns gradient length.
float sobelLuma(vec2 uv, vec2 s) {
  float tl = edgeLuma(uv + vec2(-s.x, -s.y)), t = edgeLuma(uv + vec2(0.0, -s.y)), tr = edgeLuma(uv + vec2(s.x, -s.y));
  float l  = edgeLuma(uv + vec2(-s.x,  0.0)),                                      r  = edgeLuma(uv + vec2(s.x,  0.0));
  float bl = edgeLuma(uv + vec2(-s.x,  s.y)), b = edgeLuma(uv + vec2(0.0,  s.y)), br = edgeLuma(uv + vec2(s.x,  s.y));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  return length(vec2(gx, gy));
}

float maskAt(vec2 uv) { return texture(u_mask, uv).r; }

float sobelMask(vec2 uv, vec2 s) {
  float tl = maskAt(uv + vec2(-s.x, -s.y)), t = maskAt(uv + vec2(0.0, -s.y)), tr = maskAt(uv + vec2(s.x, -s.y));
  float l  = maskAt(uv + vec2(-s.x,  0.0)),                                   r  = maskAt(uv + vec2(s.x,  0.0));
  float bl = maskAt(uv + vec2(-s.x,  s.y)), b = maskAt(uv + vec2(0.0,  s.y)), br = maskAt(uv + vec2(s.x,  s.y));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  return length(vec2(gx, gy));
}

// 0..1 line coverage at uv.
float inkLine(vec2 uv) {
  vec2 s = u_texel * max(u_inkWidth * 0.75, 0.5);
  float e = sobelLuma(uv, s);
  float line = smoothstep(u_edgeLo, u_edgeHi, e);
  // Silhouette from the mask: thinner spacing so the outline hugs the person.
  float m = sobelMask(uv, u_texel * max(u_inkWidth * 0.6, 0.5));
  line = max(line, smoothstep(0.6, 1.6, m) * u_silhouette);
  return line;
}
`;

const COMMON_UNIFORMS = glsl`
uniform float u_inkWidth;   // line thickness in texels
uniform float u_edgeLo;     // Sobel magnitude where a line starts to appear
uniform float u_edgeHi;     // Sobel magnitude of a fully black line
uniform float u_silhouette; // weight of the segmentation-mask outline (0 disables)
uniform vec3  u_inkColor;   // line colour
`;

const FRAG_PAPER = glsl`
${COMMON_UNIFORMS}
uniform float u_feather;    // person/paper feather in texels
${LUMA}
${PERSON_MASK}
${SOBEL}
void main() {
  vec3 cel = texture(u_color, v_uv).rgb;
  vec3 paper = texture(u_backdrop, v_uv).rgb;
  float person = personMask(v_uv, u_feather);
  // Colour only on the person; the room becomes paper...
  vec3 col = mix(paper, cel, person);
  // ...with line-art everywhere (room edges + person detail).
  float line = inkLine(v_uv);
  col = mix(col, u_inkColor, line);
  fragColor = vec4(col, 1.0);
}
`;

const FRAG_COMIC = glsl`
${COMMON_UNIFORMS}
${LUMA}
${SOBEL}
void main() {
  vec3 cel = texture(u_color, v_uv).rgb;
  float line = inkLine(v_uv);
  fragColor = vec4(mix(cel, u_inkColor, line), 1.0);
}
`;

function baseUniforms(ctx: PassContext): Uniforms {
  return {
    u_inkWidth: inkWidthTexels(ctx),
    u_edgeLo: 0.2,
    u_edgeHi: 0.5,
    u_silhouette: 0.85,
    u_inkColor: INK_RGB,
  };
}

export const inkPaper: StylePass = {
  id: 'ink-paper',
  frag: FRAG_PAPER,
  uniforms: (ctx) => ({ ...baseUniforms(ctx), u_feather: 6 * (ctx.height / 720) }),
};

export const inkComic: StylePass = {
  id: 'ink-comic',
  frag: FRAG_COMIC,
  uniforms: baseUniforms,
};
