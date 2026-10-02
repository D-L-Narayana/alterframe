/**
 * Compositor-internal GLSL bodies (prelude is prepended by the core, see prelude.ts).
 * These are not StylePasses visible to W5; they implement ingest, window compositing and present.
 */

/** Raw video → display-space video. The single mirror in the pipeline (`u_mirror` 0/1). */
export const INGEST_FRAG = `uniform float u_mirror;
void main() {
  vec2 uv = vec2(mix(v_uv.x, 1.0 - v_uv.x, u_mirror), v_uv.y);
  fragColor = vec4(texture(u_color, uv).rgb, 1.0);
}`;

/** Vertex shader for the window quad: a_clip from fit.displayToClip, a_uv = display uv to sample. */
export const QUAD_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_clip;
layout(location = 1) in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_clip, 0.0, 1.0);
}
`;

/**
 * Window content = window layer ⊕ persona overlay (normal alpha), with the optional thin-strip
 * glitch: per scan-band horizontal UV shift, RGB split and a little static, all scaled by u_glitch.
 * Alpha out = u_opacity (quad fade). Only fragments inside the two quad triangles run this.
 */
export const WINDOW_FRAG = `uniform sampler2D u_window;
uniform sampler2D u_overlay;
uniform float u_opacity;
uniform float u_glitch;

float hash1(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec2 uv = v_uv;
  vec3 col;
  if (u_glitch > 0.0) {
    // Time quantised to 24 Hz so bands jump rather than slide; bands are ~1/90 of the frame.
    float slot = floor(u_time * 24.0);
    float band = floor(uv.y * 90.0);
    float gate = step(1.0 - 0.6 * u_glitch, hash1(band * 3.71 + slot * 2.3));   // which bands shift
    float shift = (hash1(band * 7.13 + slot * 1.71) - 0.5) * 0.12 * u_glitch * gate;
    uv.x = clamp(uv.x + shift, 0.0, 1.0);
    float split = 0.006 * u_glitch;
    col.r = texture(u_window, vec2(clamp(uv.x + split, 0.0, 1.0), uv.y)).r;
    col.g = texture(u_window, uv).g;
    col.b = texture(u_window, vec2(clamp(uv.x - split, 0.0, 1.0), uv.y)).b;
    float grain = hash1(dot(floor(gl_FragCoord.xy * 0.5), vec2(1.0, 311.7)) + slot * 17.0);
    col = mix(col, vec3(grain), 0.35 * u_glitch * u_glitch * gate);
  } else {
    col = texture(u_window, uv).rgb;
  }
  vec4 ov = texture(u_overlay, uv);        // straight (non-premultiplied) alpha from canvas 2D
  col = mix(col, ov.rgb, clamp(ov.a, 0.0, 1.0));
  fragColor = vec4(col, u_opacity);
}`;

/**
 * Present: default framebuffer shows clip y=+1 at the top, so flip once, then map canvas uv →
 * display uv through the cover-fit transform and sample the composite and the HUD identically.
 */
export const PRESENT_FRAG = `uniform sampler2D u_hud;
uniform vec2 u_fitScale;
uniform vec2 u_fitOffset;
void main() {
  vec2 canvasUv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 duv = canvasUv * u_fitScale + u_fitOffset;
  vec3 c = texture(u_color, duv).rgb;
  vec4 h = texture(u_hud, duv);
  fragColor = vec4(mix(c, h.rgb, clamp(h.a, 0.0, 1.0)), 1.0);
}`;
