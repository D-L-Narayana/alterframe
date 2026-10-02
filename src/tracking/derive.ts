import type { Rect, Vec2, Vec3 } from '../types/geometry';
import { FACE_LM, HAND_LM } from '../types/tracking';
import type { FaceTrack, HandSide, HandTrack } from '../types/tracking';

/**
 * Pure derivation helpers. Everything here works on landmarks that are ALREADY in display
 * space (mirrored when the app mirrors). No MediaPipe imports, so these are unit-testable.
 */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Mirror x → 1 - x. Writes into `out` (reused) when provided. */
export function mirrorLandmarks(landmarks: readonly Vec3[], out: Vec3[] = []): Vec3[] {
  out.length = landmarks.length;
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i]!;
    const o = out[i];
    if (o) { o.x = 1 - p.x; o.y = p.y; o.z = p.z; }
    else out[i] = { x: 1 - p.x, y: p.y, z: p.z };
  }
  return out;
}

/** Palm landmarks whose mean gives a stable "palm centre" (wrist + 4 finger MCPs). */
const PALM_IDS = [HAND_LM.WRIST, HAND_LM.INDEX_MCP, HAND_LM.MIDDLE_MCP, 13, HAND_LM.PINKY_MCP] as const;

/**
 * Build a HandTrack from 21 display-space landmarks.
 * @param aspect source width / height — used to express `size` in units of frame height.
 */
export function deriveHand(landmarks: Vec3[], score: number, side: HandSide, aspect = 16 / 9): HandTrack {
  const idx = landmarks[HAND_LM.INDEX_TIP]!;
  const thb = landmarks[HAND_LM.THUMB_TIP]!;
  let cx = 0, cy = 0;
  for (const i of PALM_IDS) { const p = landmarks[i]!; cx += p.x; cy += p.y; }
  cx /= PALM_IDS.length; cy /= PALM_IDS.length;
  const w = landmarks[HAND_LM.WRIST]!;
  const m = landmarks[HAND_LM.MIDDLE_MCP]!;
  // Normalized x spans `aspect` times more real distance than normalized y; scale dx so the
  // length is measured in "frame heights" regardless of direction.
  const dx = (m.x - w.x) * aspect;
  const dy = m.y - w.y;
  return {
    side,
    landmarks,
    score: clamp01(score),
    indexTip: { x: idx.x, y: idx.y },
    thumbTip: { x: thb.x, y: thb.y },
    palmCenter: { x: cx, y: cy },
    size: Math.hypot(dx, dy),
  };
}

/** Sort hands by palmCenter.x ascending (screen-left first). Returns a new array. */
export function sortHands(hands: readonly HandTrack[]): HandTrack[] {
  return [...hands].sort((a, b) => a.palmCenter.x - b.palmCenter.x);
}

/**
 * Assign `side` from screen position: with two hands the smaller x is 'left'; with one hand the
 * side is the half of the screen it is on. Mutates and returns the (sorted) array.
 */
export function assignSides(sorted: HandTrack[]): HandTrack[] {
  if (sorted.length >= 2) {
    sorted[0]!.side = 'left';
    for (let i = 1; i < sorted.length; i++) sorted[i]!.side = 'right';
  } else if (sorted.length === 1) {
    sorted[0]!.side = sorted[0]!.palmCenter.x < 0.5 ? 'left' : 'right';
  }
  return sorted;
}

/**
 * Greedy nearest-neighbour assignment of detected hands (current palm centres) to smoother
 * slots (previous palm centres, null = free). Returns `slotOf[i]` for each current hand.
 * With at most two hands a greedy match over the sorted distance list is optimal enough and
 * keeps each hand's One-Euro history attached to the same physical hand across frames, even
 * when the detector reorders its output.
 */
export function matchHands(prev: readonly (Vec2 | null)[], cur: readonly Vec2[]): number[] {
  const nSlots = Math.max(prev.length, cur.length);
  const slotOf = new Array<number>(cur.length).fill(-1);
  const taken = new Array<boolean>(nSlots).fill(false);
  const pairs: { i: number; s: number; d: number }[] = [];
  for (let i = 0; i < cur.length; i++) {
    for (let s = 0; s < prev.length; s++) {
      const p = prev[s];
      if (!p) continue;
      const c = cur[i]!;
      pairs.push({ i, s, d: Math.hypot(c.x - p.x, c.y - p.y) });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  for (const { i, s } of pairs) {
    if (slotOf[i] !== -1 || taken[s]) continue;
    slotOf[i] = s; taken[s] = true;
  }
  for (let i = 0; i < cur.length; i++) {
    if (slotOf[i] !== -1) continue;
    const free = taken.findIndex((t) => !t);
    const s = free === -1 ? taken.length : free;
    slotOf[i] = s; taken[s] = true;
  }
  return slotOf;
}

function mean2(a: Vec3, b: Vec3, c: Vec3, d: Vec3): Vec2 {
  return { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 };
}

/**
 * Eye-aspect-ratio style openness from landmark distances: vertical gap over horizontal width.
 * EAR ≈ 0.05 closed, ≈ 0.3 wide open for the MediaPipe mesh; map linearly onto 0..1.
 */
function openness(top: Vec3, bottom: Vec3, outer: Vec3, inner: Vec3, aspect: number): number {
  const w = Math.hypot((outer.x - inner.x) * aspect, outer.y - inner.y);
  if (w <= 1e-6) return 0;
  const h = Math.hypot((top.x - bottom.x) * aspect, top.y - bottom.y);
  return clamp01((h / w - 0.08) / (0.28 - 0.08));
}

/**
 * Build a FaceTrack from 478 display-space landmarks + optional blendshapes/transform.
 *
 * "left/right" in the output are the VIEWER's screen left/right: we compute both anatomical eye
 * centres and assign whichever has the smaller x to `leftEye`. Blendshapes are named
 * anatomically (eyeBlinkLeft = subject's left eye), so they are swapped along with the eyes.
 * In the default mirrored selfie view the subject's left eye IS on screen-left; un-mirrored
 * (rear camera / file with mirroring off) it is on screen-right.
 */
export function deriveFace(
  landmarks: Vec3[],
  blendshapes: Record<string, number>,
  transform: Float32Array | null,
  aspect = 16 / 9,
): FaceTrack {
  const L = (i: number): Vec3 => landmarks[i]!;
  // Anatomical eyes (MediaPipe naming): "LEFT_*" indices are the subject's left eye.
  const subjLeft = mean2(L(FACE_LM.LEFT_EYE_OUTER), L(FACE_LM.LEFT_EYE_INNER), L(FACE_LM.LEFT_EYE_TOP), L(FACE_LM.LEFT_EYE_BOTTOM));
  const subjRight = mean2(L(FACE_LM.RIGHT_EYE_OUTER), L(FACE_LM.RIGHT_EYE_INNER), L(FACE_LM.RIGHT_EYE_TOP), L(FACE_LM.RIGHT_EYE_BOTTOM));
  const subjLeftOpen = blendshapes['eyeBlinkLeft'] !== undefined
    ? 1 - clamp01(blendshapes['eyeBlinkLeft'])
    : openness(L(FACE_LM.LEFT_EYE_TOP), L(FACE_LM.LEFT_EYE_BOTTOM), L(FACE_LM.LEFT_EYE_OUTER), L(FACE_LM.LEFT_EYE_INNER), aspect);
  const subjRightOpen = blendshapes['eyeBlinkRight'] !== undefined
    ? 1 - clamp01(blendshapes['eyeBlinkRight'])
    : openness(L(FACE_LM.RIGHT_EYE_TOP), L(FACE_LM.RIGHT_EYE_BOTTOM), L(FACE_LM.RIGHT_EYE_OUTER), L(FACE_LM.RIGHT_EYE_INNER), aspect);

  const subjLeftIsScreenLeft = subjLeft.x < subjRight.x;
  const leftEye = subjLeftIsScreenLeft ? subjLeft : subjRight;
  const rightEye = subjLeftIsScreenLeft ? subjRight : subjLeft;
  const eyeOpenLeft = subjLeftIsScreenLeft ? subjLeftOpen : subjRightOpen;
  const eyeOpenRight = subjLeftIsScreenLeft ? subjRightOpen : subjLeftOpen;

  // Roll: angle of the screen-left→screen-right eye vector. y grows downward, so a positive
  // angle means the screen-right eye is lower → head tilted clockwise as seen by the viewer.
  // x is scaled by aspect so the angle is measured in real (square-pixel) space.
  const roll = Math.atan2(rightEye.y - leftEye.y, (rightEye.x - leftEye.x) * aspect);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const faceBox: Rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

  const nose = L(FACE_LM.NOSE_TIP);
  const chin = L(FACE_LM.CHIN);
  const forehead = L(FACE_LM.FOREHEAD);

  // Mouth: blendshapes when present, else lip gap / mouth width (≈0 closed … ≈0.6 wide open).
  const mL = L(FACE_LM.MOUTH_LEFT), mR = L(FACE_LM.MOUTH_RIGHT);
  const uL = L(FACE_LM.UPPER_LIP), lL = L(FACE_LM.LOWER_LIP);
  const mouthW = Math.hypot((mL.x - mR.x) * aspect, mL.y - mR.y);
  let mouthOpen: number;
  if (blendshapes['jawOpen'] !== undefined) mouthOpen = clamp01(blendshapes['jawOpen']);
  else mouthOpen = mouthW > 1e-6 ? clamp01(Math.hypot((uL.x - lL.x) * aspect, uL.y - lL.y) / mouthW / 0.6) : 0;

  let smile: number;
  if (blendshapes['mouthSmileLeft'] !== undefined || blendshapes['mouthSmileRight'] !== undefined) {
    smile = clamp01(((blendshapes['mouthSmileLeft'] ?? 0) + (blendshapes['mouthSmileRight'] ?? 0)) / 2);
  } else {
    // Fallback: corners raised above the lip centre line (in the face's own frame, i.e. roll
    // removed). lift > 0 means corners higher (smaller y) than the mid-lip → smiling.
    const midY = (uL.y + lL.y) / 2;
    const cornersY = (mL.y + mR.y) / 2;
    const cosR = Math.cos(roll);
    const lift = (midY - cornersY) * cosR; // crude de-rotation; good enough for a fallback
    smile = mouthW > 1e-6 ? clamp01(lift / (mouthW * 0.25)) : 0;
  }

  return {
    landmarks,
    blendshapes,
    transform,
    leftEye,
    rightEye,
    noseTip: { x: nose.x, y: nose.y },
    chin: { x: chin.x, y: chin.y },
    forehead: { x: forehead.x, y: forehead.y },
    faceBox,
    roll,
    eyeOpenLeft,
    eyeOpenRight,
    mouthOpen,
    smile,
  };
}
