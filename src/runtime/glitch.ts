import type { SettingsSlice, WindowQuad } from '@/types';

/** Normalized window thickness below which the optional slit effect reaches full strength. */
export const GLITCH_THICKNESS = 0.04;

/**
 * Thin-slit glitch intensity. The "static" seen when the window is a thin slit is just the
 * illustration sampled through the slit, so the effect is OFF by default and only produced when
 * the `thinStripGlitch` setting is on and reduced motion is off.
 * Formula when enabled: clamp(1 − thickness / 0.04, 0, 1).
 */
export function computeGlitch(quad: WindowQuad | null, settings: Pick<SettingsSlice, 'reducedMotion' | 'thinStripGlitch'>): number {
  if (!settings.thinStripGlitch || settings.reducedMotion || !quad || !quad.visible) return 0;
  const g = 1 - quad.thickness / GLITCH_THICKNESS;
  return g < 0 ? 0 : g > 1 ? 1 : g;
}
