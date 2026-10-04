import type { CaptureAspect } from '@/types/capture';

/**
 * Centre-crop plan: copy source rect (sx, sy, sw, sh) into an output of dw×dh.
 * All four size fields are even so video encoders (which work on 4:2:0 macroblocks)
 * never receive odd dimensions.
 */
export interface CropPlan {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dw: number;
  dh: number;
}

/** Fixed output sizes: 1080-wide portrait/square, 1080p landscape. */
export const OUTPUT_SIZES: Record<Exclude<CaptureAspect, 'source'>, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

/** Largest even integer ≤ v, never below 2. */
function evenFloor(v: number): number {
  const e = Math.floor(v) - (Math.floor(v) % 2);
  return Math.max(2, e);
}

/**
 * Compute the centre crop of a `srcW×srcH` canvas for the requested aspect.
 * - `source`: whole canvas (even-rounded), 1:1 pixel copy.
 * - others: the largest region of the source with the target aspect, centred,
 *   scaled to the fixed `OUTPUT_SIZES` entry.
 */
export function computeCrop(srcW: number, srcH: number, aspect: CaptureAspect): CropPlan {
  if (!(srcW > 0) || !(srcH > 0)) {
    throw new Error(`Cannot crop an empty canvas (${srcW}×${srcH}); the source has zero size.`);
  }
  if (aspect === 'source') {
    const w = evenFloor(srcW);
    const h = evenFloor(srcH);
    return { sx: 0, sy: 0, sw: w, sh: h, dw: w, dh: h };
  }
  const out = OUTPUT_SIZES[aspect];
  const target = out.width / out.height;
  const srcAspect = srcW / srcH;
  let sw: number;
  let sh: number;
  if (srcAspect > target) {
    // Source is wider than target: keep full height, trim the sides.
    sh = evenFloor(srcH);
    sw = evenFloor(Math.min(srcW, Math.round(sh * target)));
  } else {
    // Source is taller (or equal): keep full width, trim top/bottom.
    sw = evenFloor(srcW);
    sh = evenFloor(Math.min(srcH, Math.round(sw / target)));
  }
  const sx = Math.round((srcW - sw) / 2);
  const sy = Math.round((srcH - sh) / 2);
  return { sx, sy, sw, sh, dw: out.width, dh: out.height };
}
