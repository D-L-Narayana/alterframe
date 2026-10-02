import type { HudCallout, HudModel, SceneState, TrackingFrame, Vec2, WindowQuad } from '@/types';
import { FACE_LM } from '@/types';
import { buildCode, codePrefix } from './code';

/** Third label (second eye) only appears when the window is large, as in the reference. */
export const EYE_RIGHT_MIN_AREA = 0.06;
/** Mouth box appears when the mouth is clearly open. */
export const MOUTH_OPEN_BOX_THRESHOLD = 0.35;
/** Box width = 1.6 × mouth width. */
export const MOUTH_BOX_WIDTH_FACTOR = 1.6;
/** Minimum box height relative to its width (keeps the rectangle visible for a thin smile). */
const MOUTH_BOX_MIN_ASPECT = 0.25;

/** Thin rectangle (normalized), centred at `center`. */
export interface HudBox { center: Vec2; w: number; h: number }

/**
 * Superset of the contract `HudModel`. Extra fields are read by W8's own `draw`:
 *  - `t`: build time (ms) → blink phase for the record dot (keeps draw pure).
 *  - `boxes`: free-standing thin rectangles (mouth box). `HudCallout.id` has no
 *    'mouth' member, so the box lives here rather than on a mis-labelled callout.
 *  - `debugFrame`: the tracking frame, so the debug landmark overlay can be drawn
 *    after the HUD without the runtime passing it twice.
 */
export interface HudModelExt extends HudModel {
  t: number;
  boxes: HudBox[];
  debugFrame: TrackingFrame | null;
}

export interface BuildExtras { recording: boolean; fps: number | null; showFps: boolean }

const isFinitePoint = (p: Vec2 | undefined | null): p is Vec2 =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

function mouthBox(frame: TrackingFrame | null): HudBox | null {
  const face = frame?.face;
  if (!face || !(face.mouthOpen > MOUTH_OPEN_BOX_THRESHOLD)) return null;
  const lm = face.landmarks;
  const l = lm[FACE_LM.MOUTH_LEFT]; const r = lm[FACE_LM.MOUTH_RIGHT];
  const u = lm[FACE_LM.UPPER_LIP]; const d = lm[FACE_LM.LOWER_LIP];
  if (!isFinitePoint(l) || !isFinitePoint(r) || !isFinitePoint(u) || !isFinitePoint(d)) return null;
  const width = Math.hypot(r.x - l.x, r.y - l.y);
  const height = Math.hypot(d.x - u.x, d.y - u.y);
  if (!(width > 0)) return null;
  const center = { x: (l.x + r.x + u.x + d.x) / 4, y: (l.y + r.y + u.y + d.y) / 4 };
  const w = width * MOUTH_BOX_WIDTH_FACTOR;
  const h = Math.max(height, width * MOUTH_BOX_MIN_ASPECT) * MOUTH_BOX_WIDTH_FACTOR;
  return { center, w, h };
}

/**
 * Pure model builder (contract W8 §1). Callouts are emitted in draw order:
 * corner → eye-left (leader from corner) → eye-right (leader from eye-left, large windows only).
 */
export function buildHudModel(
  frame: TrackingFrame | null,
  quad: WindowQuad | null,
  scene: SceneState,
  t: number,
  extras: BuildExtras,
  seed = 0,
): HudModelExt {
  const base: HudModelExt = {
    tint: scene.hudTint,
    callouts: [],
    opacity: 0,
    recording: extras.recording,
    fps: extras.showFps && extras.fps !== null && Number.isFinite(extras.fps) ? extras.fps : null,
    t,
    boxes: [],
    debugFrame: frame,
  };
  if (!quad || !quad.visible) return base;

  const prefix = codePrefix(t, seed);
  const cornerAnchor = quad.corners[0];
  const callouts: HudCallout[] = [
    { id: 'corner', anchor: cornerAnchor, code: buildCode(prefix, 'corner'), bracket: true },
  ];

  const face = frame?.face ?? null;
  if (face) {
    // Leader chain: corner → eye-left → eye-right. If eye-left is unusable the
    // second eye chains straight from the corner so the line never dangles.
    let previous: Vec2 = cornerAnchor;
    if (isFinitePoint(face.leftEye)) {
      callouts.push({ id: 'eye-left', anchor: face.leftEye, code: buildCode(prefix, 'eye-left'), leaderTo: previous, bracket: true });
      previous = face.leftEye;
    }
    if (quad.area > EYE_RIGHT_MIN_AREA && isFinitePoint(face.rightEye)) {
      callouts.push({ id: 'eye-right', anchor: face.rightEye, code: buildCode(prefix, 'eye-right'), leaderTo: previous, bracket: true });
    }
  }

  const box = mouthBox(frame);
  return {
    ...base,
    callouts,
    opacity: Math.min(1, Math.max(0, quad.opacity)),
    boxes: box ? [box] : [],
  };
}
