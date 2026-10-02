import type { Vec3, Size, FaceTrack, TrackingFrame } from '../../../src/types';
import { FACE_LM } from '../../../src/types';

export const SIZE: Size = { width: 1000, height: 500 };

/** 478 landmarks all at the face centre unless overridden; keeps the geometry helpers deterministic. */
export function makeLandmarks(overrides: Record<number, Vec3> = {}, base: Vec3 = { x: 0.5, y: 0.5, z: 0 }): Vec3[] {
  const lm: Vec3[] = Array.from({ length: 478 }, () => ({ ...base }));
  for (const [k, v] of Object.entries(overrides)) lm[Number(k)] = { ...v };
  return lm;
}

/**
 * Synthetic frontal face: oval of radius (rx, ry) around (cx, cy), eyes at ±0.4rx, mouth below.
 * `roll` rotates every point clockwise on screen (positive).
 */
export function makeFace(opts: { cx?: number; cy?: number; rx?: number; ry?: number; roll?: number; eyeOpen?: number; mouthOpen?: number } = {}): FaceTrack {
  const { cx = 0.5, cy = 0.5, rx = 0.1, ry = 0.14, roll = 0, eyeOpen = 1, mouthOpen = 0 } = opts;
  const rot = (x: number, y: number): Vec3 => {
    // rotate (x,y) about (cx,cy) by roll; screen y points down so clockwise == positive angle in canvas maths
    const dx = x - cx, dy = y - cy;
    return { x: cx + dx * Math.cos(roll) - dy * Math.sin(roll), y: cy + dx * Math.sin(roll) + dy * Math.cos(roll), z: 0 };
  };
  const lm = makeLandmarks({}, { x: cx, y: cy, z: 0 });
  const put = (i: number, x: number, y: number) => { lm[i] = rot(x, y); };
  // eyes (mesh "right" = screen-left after mirroring in our convention; we only need consistent geometry)
  const ew = rx * 0.5, eh = ry * 0.12 * eyeOpen;
  const eyeL = { x: cx - rx * 0.45, y: cy - ry * 0.15 };
  const eyeR = { x: cx + rx * 0.45, y: cy - ry * 0.15 };
  put(FACE_LM.RIGHT_EYE_OUTER, eyeL.x - ew / 2, eyeL.y); put(FACE_LM.RIGHT_EYE_INNER, eyeL.x + ew / 2, eyeL.y);
  put(FACE_LM.RIGHT_EYE_TOP, eyeL.x, eyeL.y - eh / 2); put(FACE_LM.RIGHT_EYE_BOTTOM, eyeL.x, eyeL.y + eh / 2);
  put(FACE_LM.RIGHT_IRIS_CENTER, eyeL.x, eyeL.y);
  put(FACE_LM.LEFT_EYE_OUTER, eyeR.x + ew / 2, eyeR.y); put(FACE_LM.LEFT_EYE_INNER, eyeR.x - ew / 2, eyeR.y);
  put(FACE_LM.LEFT_EYE_TOP, eyeR.x, eyeR.y - eh / 2); put(FACE_LM.LEFT_EYE_BOTTOM, eyeR.x, eyeR.y + eh / 2);
  put(FACE_LM.LEFT_IRIS_CENTER, eyeR.x, eyeR.y);
  // eye contours (16 points each) as small ellipses so polygon helpers have real rings
  const ringR = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
  const ringL = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
  ringR.forEach((i, k) => { const a = (k / 16) * Math.PI * 2; put(i, eyeL.x + Math.cos(a) * ew / 2, eyeL.y + Math.sin(a) * eh / 2); });
  ringL.forEach((i, k) => { const a = (k / 16) * Math.PI * 2; put(i, eyeR.x + Math.cos(a) * ew / 2, eyeR.y + Math.sin(a) * eh / 2); });
  // mouth
  const my = cy + ry * 0.45, mw = rx * 0.6, mh = ry * 0.06 + mouthOpen * ry * 0.3;
  put(FACE_LM.MOUTH_LEFT, cx - mw / 2, my); put(FACE_LM.MOUTH_RIGHT, cx + mw / 2, my);
  put(FACE_LM.UPPER_LIP, cx, my - mh / 2); put(FACE_LM.LOWER_LIP, cx, my + mh / 2);
  const lips = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
  lips.forEach((i, k) => { const a = (k / 20) * Math.PI * 2; put(i, cx + Math.cos(a) * mw / 2, my + Math.sin(a) * mh / 2); });
  // cheeks, brows, chin, forehead, nose
  put(FACE_LM.LEFT_CHEEK, cx + rx * 0.55, cy + ry * 0.15); put(FACE_LM.RIGHT_CHEEK, cx - rx * 0.55, cy + ry * 0.15);
  put(FACE_LM.CHIN, cx, cy + ry); put(FACE_LM.FOREHEAD, cx, cy - ry); put(FACE_LM.NOSE_TIP, cx, cy + ry * 0.1);
  // face oval ring
  const oval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  oval.forEach((i, k) => { const a = -Math.PI / 2 + (k / 36) * Math.PI * 2; put(i, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); });

  const p = (i: number) => { const v = lm[i]!; return { x: v.x, y: v.y }; };
  return {
    landmarks: lm, blendshapes: {}, transform: null,
    leftEye: p(FACE_LM.RIGHT_IRIS_CENTER), rightEye: p(FACE_LM.LEFT_IRIS_CENTER),
    noseTip: p(FACE_LM.NOSE_TIP), chin: p(FACE_LM.CHIN), forehead: p(FACE_LM.FOREHEAD),
    faceBox: { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 },
    roll, eyeOpenLeft: eyeOpen, eyeOpenRight: eyeOpen, mouthOpen, smile: 0,
  };
}

export function makeFrame(face: FaceTrack | null, t = 0): TrackingFrame {
  return { t, sourceWidth: 1280, sourceHeight: 720, hands: [], face, segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } };
}
