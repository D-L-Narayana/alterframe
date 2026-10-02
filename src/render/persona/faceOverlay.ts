import type { FaceTrack, Size, Vec2, PersonaId } from '../../types';
import type { Ctx2D } from './canvas';
import { PERSONA_PALETTE, PORTRAIT_IRIS, withAlpha, mixHex } from './palette';
import {
  eyeMetrics, lensShape, faceOvalPolygon, scalePolygon, polygonCentroid, torsoPolygon, mouthMetrics,
  toPx, clamp01, TORSO, type LensPath, type EyeMetrics,
} from './geometry';
import { spiderEmblem } from './suitEmblem';

/*
 * Face/body-attached overlays. The overlay canvas is RGBA and composited by W4 with normal
 * alpha on top of the stylised video INSIDE the window, so everything here stays ≤ 0.9 alpha
 * (except the opaque mask lenses, which must hide the eyes) to let the cel shading breathe.
 *
 * All shapes come from the current frame's landmarks (already mirrored, normalized), so
 * they stay pixel-aligned to the face at any head roll; `face.roll` only orients ellipses.
 */

/** Overlay maximum alpha (contract: ≤ 0.9 so W5's cel shading shows through). */
export const OVERLAY_MAX_ALPHA = 0.9;

/** Device-independent stroke unit: 1 at 720 px tall. */
const unit = (size: Size) => Math.max(0.75, size.height / 720);

function pathPolygon(ctx: Ctx2D, pts: readonly Vec2[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
}

function pathLens(ctx: Ctx2D, lens: LensPath): void {
  ctx.beginPath();
  ctx.moveTo(lens.start.x, lens.start.y);
  for (const [c1, c2, e] of lens.segments) ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
  ctx.closePath();
}

function pathEllipse(ctx: Ctx2D, cx: number, cy: number, rx: number, ry: number, rot: number): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, Math.PI * 2);
}

/** Smooth 0..1 ramp used to fade eye accents as the lid closes (blink). */
const smoothstep = (v: number) => { const x = clamp01(v); return x * x * (3 - 2 * x); };

// ───────────────────────────── portrait ─────────────────────────────

function drawEyeAccent(ctx: Ctx2D, eye: EyeMetrics, roll: number, size: Size): void {
  const open = smoothstep((eye.open - 0.15) / 0.6);   // fully faded below 15 % open, full above 75 %
  if (open <= 0.001) return;
  const u = unit(size);
  const rx = (eye.width * 1.35) / 2;
  const ry = rx * 0.82 * (0.3 + 0.7 * open);          // squash with the lid
  const { x: cx, y: cy } = eye.center;
  ctx.save();
  ctx.globalAlpha = 0.85 * open;
  // iris: brown core → darker rim
  const g = ctx.createRadialGradient(cx, cy, rx * 0.1, cx, cy, rx);
  g.addColorStop(0, mixHex(PORTRAIT_IRIS, PERSONA_PALETTE.portrait.highlight, 0.25));
  g.addColorStop(0.6, PORTRAIT_IRIS);
  g.addColorStop(1, mixHex(PORTRAIT_IRIS, PERSONA_PALETTE.portrait.ink, 0.55));
  pathEllipse(ctx, cx, cy, rx, ry, roll);
  ctx.fillStyle = g;
  ctx.fill();
  // pupil
  pathEllipse(ctx, cx, cy, rx * 0.42, ry * 0.42, roll);
  ctx.fillStyle = PERSONA_PALETTE.portrait.ink;
  ctx.fill();
  // glossy highlights: large upper-left, small lower-right (in the rolled frame)
  const c = Math.cos(roll), s = Math.sin(roll);
  const hl = (ox: number, oy: number, r: number, a: number) => {
    const px = cx + ox * c - oy * s, py = cy + ox * s + oy * c;
    ctx.globalAlpha = a * open;
    pathEllipse(ctx, px, py, r, r * 0.85, roll);
    ctx.fillStyle = PERSONA_PALETTE.portrait.highlight;
    ctx.fill();
  };
  hl(-rx * 0.38, -ry * 0.38, rx * 0.3, 0.95);
  hl(rx * 0.4, ry * 0.42, rx * 0.13, 0.8);
  // upper lid ink line: a thick arc hugging the top of the ellipse
  ctx.globalAlpha = 0.9 * open;
  ctx.strokeStyle = PERSONA_PALETTE.portrait.ink;
  ctx.lineWidth = 2.2 * u;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 1.08, ry * 1.08, roll, Math.PI * 1.12, Math.PI * 1.88);
  ctx.stroke();
  ctx.restore();
}

/** Portrait: glossy eye accents (fade on blink), pink cheek blush and a lip tint. */
export function drawPortraitOverlay(ctx: Ctx2D, face: FaceTrack, size: Size): void {
  const P = PERSONA_PALETTE.portrait;
  const faceW = face.faceBox.w * size.width;
  // blush
  for (const key of ['LEFT_CHEEK', 'RIGHT_CHEEK'] as const) {
    const idx = key === 'LEFT_CHEEK' ? 425 : 205;
    const lm = face.landmarks[idx];
    if (!lm) continue;
    const p = toPx(lm, size);
    const rx = faceW * 0.14, ry = faceW * 0.085;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rx);
    g.addColorStop(0, withAlpha(P.blush, 0.32));
    g.addColorStop(1, withAlpha(P.blush, 0));
    ctx.save();
    ctx.globalAlpha = 1;
    pathEllipse(ctx, p.x, p.y, rx, ry, face.roll);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }
  // eyes
  drawEyeAccent(ctx, eyeMetrics(face, 'left', size), face.roll, size);
  drawEyeAccent(ctx, eyeMetrics(face, 'right', size), face.roll, size);
  // lips: outer ring polygon at 55 % (fallback: ellipse from corner/lip anchors)
  const m = mouthMetrics(face, size);
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = mixHex(P.lip, P.ink, 0.12);
  if (m.ring.length >= 8) pathPolygon(ctx, m.ring);
  else pathEllipse(ctx, m.center.x, m.center.y, m.width / 2, Math.max(m.height / 2, m.width * 0.18), m.angle);
  ctx.fill();
  ctx.restore();
}

// ───────────────────────────── masked ─────────────────────────────

/**
 * Masked hero: a full-face white mask (face oval, 92 %, soft inner shading) with two opaque
 * teardrop lenses outlined magenta→pink. Per reference errata §4b.3 the eyes are NOT revealed.
 */
export function drawMaskedOverlay(ctx: Ctx2D, face: FaceTrack, size: Size): void {
  const M = PERSONA_PALETTE.masked;
  const u = unit(size);
  const oval = scalePolygon(faceOvalPolygon(face.landmarks, size), 1.04);
  if (oval.length < 3) return;
  const c = polygonCentroid(oval);
  const faceW = face.faceBox.w * size.width;

  // mask body
  ctx.save();
  ctx.globalAlpha = 0.92;
  pathPolygon(ctx, oval);
  ctx.fillStyle = M.mask;
  ctx.fill();
  // soft inner shading: darker towards the rim, slightly magenta at the bottom (hood lining glow)
  ctx.clip();
  const g = ctx.createRadialGradient(c.x, c.y - faceW * 0.1, faceW * 0.25, c.x, c.y, faceW * 0.75);
  g.addColorStop(0, withAlpha(M.shade, 0));
  g.addColorStop(0.75, withAlpha(M.shade, 0.06));
  g.addColorStop(1, withAlpha(M.shade, 0.22));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size.width, size.height);
  const lining = ctx.createLinearGradient(0, c.y, 0, c.y + faceW * 0.9);
  lining.addColorStop(0, withAlpha(M.lensOutlineB, 0));
  lining.addColorStop(1, withAlpha(M.lensOutlineB, 0.18));
  ctx.fillStyle = lining;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.restore();

  // rim line for definition against skin/hair
  ctx.save();
  ctx.globalAlpha = 0.5;
  pathPolygon(ctx, oval);
  ctx.strokeStyle = M.shade;
  ctx.lineWidth = 1.5 * u;
  ctx.stroke();
  ctx.restore();

  // lenses (opaque)
  const lw = 4 * u;
  for (const side of ['left', 'right'] as const) {
    const eye = eyeMetrics(face, side, size);
    const lens = lensShape(eye, side, face.roll, 1.12);
    ctx.save();
    ctx.globalAlpha = 1;
    pathLens(ctx, lens);
    // fill: white with a faint cool shading toward the inner end
    const lg = ctx.createLinearGradient(lens.start.x, lens.start.y, lens.tip.x, lens.tip.y);
    lg.addColorStop(0, mixHex(M.mask, M.neonA, 0.08));
    lg.addColorStop(1, M.mask);
    ctx.fillStyle = lg;
    ctx.fill();
    // outline: magenta at the inner end → pink at the tip
    const og = ctx.createLinearGradient(lens.start.x, lens.start.y, lens.tip.x, lens.tip.y);
    og.addColorStop(0, M.lensOutlineA);
    og.addColorStop(1, M.lensOutlineB);
    ctx.strokeStyle = og;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // thin inner highlight line to sell the lens curvature
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = M.lensOutlineA;
    ctx.lineWidth = 1 * u;
    pathLens(ctx, lensShape(eye, side, face.roll, 0.96));
    ctx.stroke();
    ctx.restore();
  }
}

// ───────────────────────────── suit ─────────────────────────────

/**
 * Web suit: torso from the jaw line down. Black hood/jacket outside, pink suit panel in the
 * middle with a white chest panel, a radial web (1 px white, 70 %) over the pink areas and
 * the original spider crest on the chest. Flat colours at ≤ 0.9 alpha.
 */
export function drawSuitOverlay(ctx: Ctx2D, face: FaceTrack, size: Size): void {
  const S = PERSONA_PALETTE.suit;
  const u = unit(size);
  const torso = torsoPolygon(face, size);
  const chin = toPx(face.chin, size);
  const faceW = face.faceBox.w * size.width, faceH = face.faceBox.h * size.height;
  const neckY = chin.y + TORSO.neckDrop * faceH;
  const shoulderY = chin.y + TORSO.shoulderDrop * faceH;
  const bottom = size.height;

  ctx.save();
  ctx.globalAlpha = OVERLAY_MAX_ALPHA * 0.98;
  pathPolygon(ctx, torso);
  ctx.clip();

  // 1) hood / jacket: everything black first
  ctx.fillStyle = S.black;
  ctx.fillRect(0, 0, size.width, size.height);

  // 2) pink suit panel: V neckline below the chin opening to the chest, slightly tapering
  const pinkHalfTop = faceW * 0.3, pinkHalfBottom = faceW * 0.7;
  const pink: Vec2[] = [
    { x: chin.x - pinkHalfTop, y: neckY - faceH * 0.02 },
    { x: chin.x + pinkHalfTop, y: neckY - faceH * 0.02 },
    { x: chin.x + pinkHalfBottom, y: shoulderY + faceH * 0.3 },
    { x: chin.x + pinkHalfBottom, y: bottom },
    { x: chin.x - pinkHalfBottom, y: bottom },
    { x: chin.x - pinkHalfBottom, y: shoulderY + faceH * 0.3 },
  ];
  pathPolygon(ctx, pink);
  ctx.fillStyle = S.pink;
  ctx.fill();

  // 3) white chest panel: narrow at the collar, widening to the chest, rounded bottom
  const whiteTop = neckY + faceH * 0.05;
  const whiteHalfTop = faceW * 0.14, whiteHalf = faceW * 0.3;
  const chestY = shoulderY + faceH * 0.15;
  const white: Vec2[] = [
    { x: chin.x - whiteHalfTop, y: whiteTop },
    { x: chin.x + whiteHalfTop, y: whiteTop },
    { x: chin.x + whiteHalf, y: chestY },
    { x: chin.x + whiteHalf * 0.85, y: bottom },
    { x: chin.x - whiteHalf * 0.85, y: bottom },
    { x: chin.x - whiteHalf, y: chestY },
  ];
  pathPolygon(ctx, white);
  ctx.fillStyle = S.white;
  ctx.fill();

  // 4) web pattern only on the pink areas: clip = pink minus white (even-odd)
  ctx.save();
  ctx.beginPath();
  pink.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))); ctx.closePath();
  white.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))); ctx.closePath();
  ctx.clip('evenodd');
  const hub = { x: chin.x, y: chestY - faceH * 0.05 };
  ctx.strokeStyle = withAlpha(S.white, 0.7);
  ctx.lineWidth = 1 * u;
  const spokes = 20;
  const reach = Math.hypot(faceW, bottom - hub.y) + faceW;
  ctx.beginPath();
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    ctx.moveTo(hub.x, hub.y);
    ctx.lineTo(hub.x + Math.cos(a) * reach, hub.y + Math.sin(a) * reach);
  }
  ctx.stroke();
  // concentric "threads": sagging quadratic arcs between neighbouring spokes
  const step = faceW * 0.11;
  ctx.beginPath();
  for (let r = step; r < reach; r += step) {
    for (let i = 0; i < spokes; i++) {
      const a0 = (i / spokes) * Math.PI * 2, a1 = ((i + 1) / spokes) * Math.PI * 2, am = (a0 + a1) / 2;
      const p0 = { x: hub.x + Math.cos(a0) * r, y: hub.y + Math.sin(a0) * r };
      const p1 = { x: hub.x + Math.cos(a1) * r, y: hub.y + Math.sin(a1) * r };
      const sag = r * 0.92; // control point pulled toward the hub → threads sag inward
      const cp = { x: hub.x + Math.cos(am) * sag, y: hub.y + Math.sin(am) * sag };
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(cp.x, cp.y, p1.x, p1.y);
    }
  }
  ctx.stroke();
  ctx.restore();

  // 5) hood band: a black collar following the jaw, so the suit starts below the neck
  const collar: Vec2[] = [
    ...torso.slice(0, 19),                         // jaw line (screen-right → screen-left)
    { x: chin.x - faceW * 0.5, y: neckY + faceH * 0.04 },
    { x: chin.x, y: neckY + faceH * 0.09 },
    { x: chin.x + faceW * 0.5, y: neckY + faceH * 0.04 },
  ];
  pathPolygon(ctx, collar);
  ctx.fillStyle = S.black;
  ctx.fill();

  // 6) seams: thin black lines separating the colour blocks
  ctx.strokeStyle = withAlpha(S.black, 0.85);
  ctx.lineWidth = 2 * u;
  ctx.lineJoin = 'round';
  pathPolygon(ctx, white); ctx.stroke();
  pathPolygon(ctx, pink); ctx.stroke();

  // 7) spider crest on the chest, legs reaching over the pink
  const crest = spiderEmblem({ x: chin.x, y: chestY + faceH * 0.06 }, faceW);
  ctx.lineCap = 'round';
  // legs: black outline then white core
  for (const pass of [{ col: S.black, w: 7 * u }, { col: S.white, w: 3.4 * u }]) {
    ctx.strokeStyle = pass.col;
    ctx.lineWidth = pass.w;
    ctx.beginPath();
    for (const leg of crest.legs) {
      ctx.moveTo(leg.root.x, leg.root.y);
      ctx.quadraticCurveTo(leg.knee.x, leg.knee.y, leg.tip.x, leg.tip.y);
    }
    ctx.stroke();
  }
  // body
  pathEllipse(ctx, crest.abdomen.c.x, crest.abdomen.c.y, crest.abdomen.rx, crest.abdomen.ry, 0);
  ctx.fillStyle = S.white; ctx.strokeStyle = S.black; ctx.lineWidth = 1.6 * u;
  ctx.fill(); ctx.stroke();
  pathEllipse(ctx, crest.head.c.x, crest.head.c.y, crest.head.r, crest.head.r, 0);
  ctx.fill(); ctx.stroke();

  ctx.restore();
}

/** Dispatch by persona. The overlay canvas must already be cleared by the caller. */
export function drawOverlay(ctx: Ctx2D, persona: PersonaId, face: FaceTrack, size: Size): void {
  switch (persona) {
    case 'portrait': drawPortraitOverlay(ctx, face, size); break;
    case 'masked': drawMaskedOverlay(ctx, face, size); break;
    case 'suit': drawSuitOverlay(ctx, face, size); break;
  }
}
