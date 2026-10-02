/**
 * W7 — dev overlay: hand skeletons, the four window corners, quad outline, gesture state.
 * Called by W8's HUD when `settings.debugLandmarks` is on. Uses only a tiny Canvas2D subset
 * (`DebugCanvas2D`) so it can be unit-tested with a recording double and works with both
 * `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D`.
 */
import { HAND_LM } from '../types';
import type { InteractionOutput, Size, TrackingFrame, Vec2, WindowQuad } from '../types';

export interface DebugCanvas2D {
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
}

/** MediaPipe hand skeleton (21 edges). */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],          // index
  [5, 9], [9, 10], [10, 11], [11, 12],     // middle
  [9, 13], [13, 14], [14, 15], [15, 16],   // ring
  [13, 17], [17, 18], [18, 19], [19, 20],  // pinky
  [0, 17],                                 // palm base
];

export interface DebugDrawExtras {
  quad?: WindowQuad | null;
  debug?: InteractionOutput['debug'];
}

const COLORS = {
  skeletonLeft: 'rgba(59,123,255,0.9)',
  skeletonRight: 'rgba(255,79,182,0.9)',
  dot: 'rgba(245,245,247,0.8)',
  corner: '#ffd60a',
  quad: 'rgba(255,214,10,0.9)',
  text: '#f5f5f7',
} as const;

const TAU = Math.PI * 2;

function finite(v: Vec2 | undefined): v is Vec2 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y);
}

/**
 * Draws the debug overlay in pixel space (`size` = canvas pixel size). Points with non-finite
 * coordinates are skipped so a glitchy tracker frame never poisons the canvas state.
 */
export function drawLandmarks(ctx: DebugCanvas2D, frame: TrackingFrame | null, size: Size, extras: DebugDrawExtras = {}): void {
  const W = Number.isFinite(size.width) ? size.width : 0;
  const H = Number.isFinite(size.height) ? size.height : 0;
  const px = (p: Vec2): [number, number] => [p.x * W, p.y * H];
  const scale = Math.max(1, Math.min(W, H) / 360); // keep strokes legible at any resolution

  ctx.save();
  if (frame) {
    for (const hand of frame.hands ?? []) {
      const lm = hand.landmarks ?? [];
      ctx.strokeStyle = hand.side === 'left' ? COLORS.skeletonLeft : COLORS.skeletonRight;
      ctx.lineWidth = 1.5 * scale;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a];
        const pb = lm[b];
        if (!finite(pa) || !finite(pb)) continue;
        ctx.moveTo(...px(pa));
        ctx.lineTo(...px(pb));
      }
      ctx.stroke();

      ctx.fillStyle = COLORS.dot;
      for (let i = 0; i < lm.length; i++) {
        const p = lm[i];
        if (!finite(p) || i === HAND_LM.INDEX_TIP || i === HAND_LM.THUMB_TIP) continue;
        ctx.beginPath();
        ctx.arc(...px(p), 2 * scale, 0, TAU);
        ctx.fill();
      }

      // The two window corners contributed by this hand.
      ctx.strokeStyle = COLORS.corner;
      ctx.lineWidth = 2 * scale;
      for (const tip of [hand.indexTip, hand.thumbTip]) {
        if (!finite(tip)) continue;
        ctx.beginPath();
        ctx.arc(...px(tip), 6 * scale, 0, TAU);
        ctx.stroke();
      }
    }

    const face = frame.face;
    if (face) {
      ctx.fillStyle = COLORS.corner;
      for (const p of [face.leftEye, face.rightEye, face.noseTip, face.chin, face.forehead]) {
        if (!finite(p)) continue;
        ctx.beginPath();
        ctx.arc(...px(p), 3 * scale, 0, TAU);
        ctx.fill();
      }
    }
  }

  const quad = extras.quad;
  if (quad && quad.corners.every(finite)) {
    ctx.strokeStyle = COLORS.quad;
    ctx.lineWidth = 1 * scale;
    ctx.beginPath();
    ctx.moveTo(...px(quad.corners[0]));
    ctx.lineTo(...px(quad.corners[1]));
    ctx.lineTo(...px(quad.corners[2]));
    ctx.lineTo(...px(quad.corners[3]));
    ctx.closePath();
    ctx.stroke();
  }

  if (extras.debug || quad) {
    ctx.fillStyle = COLORS.text;
    ctx.font = `${Math.round(11 * scale)}px monospace`;
    const lines: string[] = [];
    if (quad) {
      lines.push(`quad ${quad.ordering} area=${quad.area.toFixed(4)} thick=${quad.thickness.toFixed(3)} op=${quad.opacity.toFixed(2)}`);
    }
    if (extras.debug) {
      lines.push(`hands=${extras.debug.handsUsed} together=${Math.round(extras.debug.togetherMs)}ms armed=${extras.debug.armed}`);
    }
    const lineH = 14 * scale;
    lines.forEach((text, i) => ctx.fillText(text, 8 * scale, H - 8 * scale - (lines.length - 1 - i) * lineH));
  }
  ctx.restore();
}
