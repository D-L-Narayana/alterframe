import type { StylePass, StylePreset } from '@/types';

/** Copies the previous pass output (or the video for the first pass). */
export const passthrough: StylePass = {
  id: 'passthrough',
  frag: `void main() { fragColor = texture(u_color, v_uv); }`,
};

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

/** Fills the whole pass with one colour (test/tooling pass; also handy as an opaque backdrop). */
export function solid(color: Rgb | Rgba): StylePass {
  const rgba: Rgba = color.length === 4 ? color : [color[0], color[1], color[2], 1];
  return {
    id: `solid(${rgba.map((c) => +c.toFixed(4)).join(',')})`,
    frag: `uniform vec4 u_solidColor;
void main() { fragColor = u_solidColor; }`,
    uniforms: () => ({ u_solidColor: rgba }),
  };
}

/** Wrap a single pass (or several) into a preset without touching the shipped STYLE_PRESETS. */
export function presetOf(passes: StylePass[], id: StylePreset['id'] = 'comic', usesBackdrop = false): StylePreset {
  return { id, passes, usesBackdrop };
}
