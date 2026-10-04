/**
 * Segmentation-mask plumbing (pure, no MediaPipe imports).
 *
 * MediaPipe's ImageSegmenter returns an MPMask at the INPUT resolution. We resample it to a fixed
 * square (`MASK_SIZE`) into a reusable Float32Array, applying two optional flips in the same pass:
 *   - `mirror`  → columns reversed (selfie view, same convention as the landmarks).
 *   - `flipY`   → rows reversed. Kept as an escape hatch: WebGL textures are bottom-left origin
 *                 and a `readPixels` read-back is bottom-up in general, but MediaPipe 1.0.1
 *                 already compensates — measured identical orientation for the CPU and GPU paths
 *                 (same mask quadrant masses with both delegates in the Chromium run of
 *                 src/tracking/__harness__/verify.mjs). `maskOrientationFlipY` encodes the policy.
 */

export const MASK_SIZE = 256;

export type MaskFlipPolicy = 'auto' | 'always' | 'never';

/**
 * Decide whether to flip rows.
 *
 * Measured with @mediapipe/tasks-vision 1.0.1 in Chromium (harness `verify.mjs`: a synthetic person
 * placed in a known quadrant gives the same mask quadrant masses on both delegates): BOTH the CPU
 * path and the GPU-texture read-back path return a top-left-origin array — MediaPipe already
 * accounts for the GL bottom-left origin before `readPixels`. So 'auto' never flips; the policy
 * exists so a device that disagrees can be corrected with `maskFlipY: 'always'` without a code
 * change. `fromGpuTexture` (= `mask.hasWebGLTexture()`) is recorded for diagnostics.
 */
export function maskOrientationFlipY(policy: MaskFlipPolicy, fromGpuTexture: boolean): boolean {
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  void fromGpuTexture; // orientation verified identical for both paths (1.0.1)
  return false;
}

export interface ResampleFlags { mirror: boolean; flipY: boolean }

/**
 * Nearest-neighbour resample `src` (srcW×srcH, row-major, top-left origin unless flipY) into
 * `dst` (dstW×dstH). Uint8 sources are normalised to 0..1. Pixel-centre sampling:
 * sx = floor((x + 0.5) * srcW / dstW).
 */
export function resampleMask(
  src: Float32Array | Uint8Array,
  srcW: number,
  srcH: number,
  dst: Float32Array,
  dstW: number,
  dstH: number,
  flags: ResampleFlags,
): Float32Array {
  const scale = src instanceof Uint8Array ? 1 / 255 : 1;
  const xMap = new Int32Array(dstW);
  for (let x = 0; x < dstW; x++) {
    let sx = Math.floor(((x + 0.5) * srcW) / dstW);
    if (sx >= srcW) sx = srcW - 1;
    xMap[x] = flags.mirror ? srcW - 1 - sx : sx;
  }
  for (let y = 0; y < dstH; y++) {
    let sy = Math.floor(((y + 0.5) * srcH) / dstH);
    if (sy >= srcH) sy = srcH - 1;
    if (flags.flipY) sy = srcH - 1 - sy;
    const srcRow = sy * srcW;
    const dstRow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      dst[dstRow + x] = src[srcRow + xMap[x]!]! * scale;
    }
  }
  return dst;
}
