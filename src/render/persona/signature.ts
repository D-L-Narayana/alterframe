import type { TrackingFrame, SceneState, Size } from '../../types';
import { FACE_LM } from '../../types';
import { FACE_OVAL_INDICES, LEFT_EYE_RING, RIGHT_EYE_RING, LIPS_OUTER_RING } from './geometry';

/*
 * Dirty tracking. `update()` only repaints a canvas when the signature of the inputs that
 * influence it changes. Signatures are plain strings of quantized values: cheap to build
 * (~120 numbers per frame) and immune to floating-point noise from the One-Euro filter.
 */

/** Round to a step, returning an integer bucket so `0.1 + 0.2` style noise cannot leak through. */
export function quantize(v: number, step: number): number {
  return Math.round(v / step);
}

/** Position step in normalized units: 0.0005 ≈ 0.6 px at 1280 wide — below anything visible. */
const POS_STEP = 0.0005;
const ANGLE_STEP = 0.004;   // rad ≈ 0.23°
const SCALAR_STEP = 0.04;   // blink / mouth / smile buckets (25 levels)
const STRENGTH_STEP = 0.02; // LookSettings.overlayStrength buckets (51 levels)
const FACE_X_STEP = 0.01;   // head position for the city parallax (≤ 0.04 % of the width per bucket at the near layer)

/** Landmarks the overlays actually read; anything else may jitter freely without a repaint. */
const OVERLAY_INDICES: readonly number[] = [
  ...FACE_OVAL_INDICES, ...LEFT_EYE_RING, ...RIGHT_EYE_RING, ...LIPS_OUTER_RING,
  FACE_LM.LEFT_IRIS_CENTER, FACE_LM.RIGHT_IRIS_CENTER, FACE_LM.LEFT_CHEEK, FACE_LM.RIGHT_CHEEK,
  FACE_LM.LEFT_EYE_OUTER, FACE_LM.LEFT_EYE_INNER, FACE_LM.LEFT_EYE_TOP, FACE_LM.LEFT_EYE_BOTTOM,
  FACE_LM.RIGHT_EYE_OUTER, FACE_LM.RIGHT_EYE_INNER, FACE_LM.RIGHT_EYE_TOP, FACE_LM.RIGHT_EYE_BOTTOM,
  FACE_LM.MOUTH_LEFT, FACE_LM.MOUTH_RIGHT, FACE_LM.UPPER_LIP, FACE_LM.LOWER_LIP,
  FACE_LM.CHIN, FACE_LM.FOREHEAD, FACE_LM.NOSE_TIP,
];

/**
 * Signature of everything the OVERLAY depends on. Time is deliberately excluded: the overlays
 * are driven purely by the face (blink comes from `eyeOpen*`, not from the clock).
 * `strength` is the look's overlayStrength (0..1), quantized to 0.02. Without a face — or at
 * strength 0, where nothing is drawn — the signature is a constant, so the canvas is cleared once
 * and then left alone while the face moves.
 */
export function overlaySignature(frame: TrackingFrame | null, scene: SceneState, size: Size, _t: number, strength = 1): string {
  const head = `${scene.persona}|${size.width}x${size.height}`;
  const face = frame?.face;
  if (!face || strength <= 0) return `${head}|noface`;
  const parts: number[] = [
    quantize(strength, STRENGTH_STEP),
    quantize(face.roll, ANGLE_STEP),
    quantize(face.eyeOpenLeft, SCALAR_STEP), quantize(face.eyeOpenRight, SCALAR_STEP),
    quantize(face.mouthOpen, SCALAR_STEP), quantize(face.smile, SCALAR_STEP),
    quantize(face.faceBox.x, POS_STEP), quantize(face.faceBox.y, POS_STEP), quantize(face.faceBox.w, POS_STEP), quantize(face.faceBox.h, POS_STEP),
    quantize(face.leftEye.x, POS_STEP), quantize(face.leftEye.y, POS_STEP), quantize(face.rightEye.x, POS_STEP), quantize(face.rightEye.y, POS_STEP),
    quantize(face.chin.x, POS_STEP), quantize(face.chin.y, POS_STEP),
  ];
  const lm = face.landmarks;
  for (const i of OVERLAY_INDICES) {
    const p = lm[i];
    if (p) parts.push(quantize(p.x, POS_STEP), quantize(p.y, POS_STEP));
  }
  return `${head}|${parts.join(',')}`;
}

/** Frame period for the animated (masked) backdrop: 30 Hz is plenty for a slow parallax drift. */
export const BACKDROP_TICK_MS = 1000 / 30;

/**
 * Signature of everything the BACKDROP depends on. Only the masked city animates — with the clock
 * and with the head position (`faceX`, normalized face-box centre x, quantized to 0.01; null = no
 * face ≡ centre) — and never under reduced motion. Paper backdrops depend on persona and size only.
 */
export function backdropSignature(scene: SceneState, size: Size, t: number, reducedMotion: boolean, faceX: number | null = null): string {
  const head = `${scene.persona}|${size.width}x${size.height}`;
  if (scene.persona === 'masked' && !reducedMotion) {
    const fx = quantize(faceX !== null && Number.isFinite(faceX) ? faceX : 0.5, FACE_X_STEP);
    return `${head}|${Math.floor(t / BACKDROP_TICK_MS)}|${fx}`;
  }
  return head;
}
