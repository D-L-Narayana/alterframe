/**
 * GLSL ES 3.00 sources shared by every pass. The fragment prelude is the contract documented in
 * src/types/render.ts (StylePass): style passes write only the body after it.
 */

/** Fullscreen triangle vertex shader. v_uv = clip*0.5+0.5 (texel row 0 == display top, see fit.ts). */
export const VERTEX_SOURCE = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // One oversized triangle covering clip space; ids 0,1,2 -> (-1,-1), (3,-1), (-1,3).
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  v_uv = vec2(x, y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

/** Uniform names the prelude declares (style passes may use them without declaring). */
export const PRELUDE_UNIFORMS = ['u_color', 'u_video', 'u_mask', 'u_backdrop', 'u_resolution', 'u_texel', 'u_time'] as const;

export const FRAG_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;                 // 0..1, (0,0) = top-left of DISPLAY space
uniform sampler2D u_color;    // previous pass output (video for the first pass)
uniform sampler2D u_video;    // mirrored live video, display space
uniform sampler2D u_mask;     // person confidence in .r, display space
uniform sampler2D u_backdrop; // persona backdrop, display space
uniform vec2  u_resolution;   // pass output size in px
uniform vec2  u_texel;        // 1 / u_resolution
uniform float u_time;         // seconds
out vec4 fragColor;
#line 1
`;

/** Prelude + body. Throws when the body carries its own #version (would not be line 1). */
export function buildFragmentSource(body: string): string {
  if (/^\s*#version/m.test(body)) {
    throw new Error('StylePass.frag must not contain #version; the core prelude provides it');
  }
  return FRAG_PRELUDE + body;
}
