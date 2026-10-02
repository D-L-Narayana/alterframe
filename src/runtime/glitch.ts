import type { SettingsSlice, WindowQuad } from '@/types';

/** Normalized window thickness below which the optional slit effect reaches full strength. */
export const GLITCH_THICKNESS = 0.04;

/**
 * Lead erratum (reference-analysis §4b.1): the "static" seen when the window
 * is a thin slit is just the illustration sampled through the slit, not a
 * glitch. So the effect is OFF by default. It is only produced when a setting
 * `thinStripGlitch` is explicitly true (the setting is not in `SettingsSlice`
 * yet — read defensively, absent ⇒ false) and reduced motion is off.
 * Formula when enabled: clamp(1 − thickness / 0.04, 0, 1).
 */
export function computeGlitch(quad: WindowQuad | null, settings: Pick<SettingsSlice, 'reducedMotion'>): number {
  const enabled = (settings as { thinStripGlitch?: unknown }).thinStripGlitch === true;
  if (!enabled || settings.reducedMotion || !quad || !quad.visible) return 0;
  const g = 1 - quad.thickness / GLITCH_THICKNESS;
  return g < 0 ? 0 : g > 1 ? 1 : g;
}
