import type { Size, TrackingFrame, Vec2 } from '@/types';
import { HAND_LM } from '@/types';
import type { Hud2D } from './draw';

/**
 * Minimal dev overlay for tracking landmarks. W7 owns the canonical
 * `drawLandmarks` (src/interaction/debugDraw.ts); this is W8's dependency-free
 * fallback with the same signature so the HUD compiles and is useful on its own.
 * Inject W7's version via `createHud({ debugDraw })` at integration.
 */

/** MediaPipe hand skeleton edges (21 landmarks → 21 bones incl. palm ring). */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],            // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],            // index
  [9, 10], [10, 11], [11, 12],               // middle
  [13, 14], [14, 15], [15, 16],              // ring
  [0, 17], [17, 18], [18, 19], [19, 20],     // pinky
  [5, 9], [9, 13], [13, 17],                 // palm
];

const DOT_R = 2.5;
const CORNER_R = 5;
const HAND_COLOR = '#3b7bff';
const CORNER_COLOR = '#ff4fb6';
const FACE_COLOR = '#7cf29a';

function dot(ctx: Hud2D, p: Vec2, r: number): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

export function drawDebugLandmarks(ctx: Hud2D, frame: TrackingFrame, size: Size): void {
  const px = (p: Vec2): Vec2 => ({ x: p.x * size.width, y: p.y * size.height });
  ctx.save();
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0;

  for (const hand of frame.hands) {
    const pts = hand.landmarks.map(px);
    ctx.strokeStyle = HAND_COLOR;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = pts[a]; const pb = pts[b];
      if (!pa || !pb) continue;
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();
    ctx.fillStyle = HAND_COLOR;
    for (let i = 0; i < pts.length; i++) {
      if (i === HAND_LM.INDEX_TIP || i === HAND_LM.THUMB_TIP) continue;
      dot(ctx, pts[i] as Vec2, DOT_R);
    }
    // The two window corners this hand supplies.
    ctx.fillStyle = CORNER_COLOR;
    dot(ctx, px(hand.indexTip), CORNER_R);
    dot(ctx, px(hand.thumbTip), CORNER_R);
  }

  const face = frame.face;
  if (face) {
    ctx.strokeStyle = FACE_COLOR;
    ctx.strokeRect(face.faceBox.x * size.width, face.faceBox.y * size.height, face.faceBox.w * size.width, face.faceBox.h * size.height);
    ctx.fillStyle = FACE_COLOR;
    for (const p of [face.leftEye, face.rightEye, face.noseTip, face.chin, face.forehead]) dot(ctx, px(p), DOT_R);
  }
  ctx.restore();
}
