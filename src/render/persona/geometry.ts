import type { Vec2, Vec3, Size, Rect, FaceTrack } from '../../types';
import { FACE_LM } from '../../types';

/*
 * Pure geometry for the persona layer. Everything here works in LAYER PIXELS (the persona
 * canvases have the same device-pixel size as the composited canvas), converted from the
 * normalized display space of the tracking contract with `toPx`. No canvas calls — unit-testable.
 */

/** Face oval ring (MediaPipe face-mesh silhouette), forehead (10) → screen-right → chin (152) → screen-left. Contract §W6. */
export const FACE_OVAL_INDICES: readonly number[] = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

/** Eye contours (16 points each). "LEFT"/"RIGHT" are mesh names (subject anatomy); screen side is resolved at runtime. */
export const RIGHT_EYE_RING: readonly number[] = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const LEFT_EYE_RING: readonly number[] = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];

/** Outer lip contour (20 points), clockwise from the screen... whichever corner 61 is. */
export const LIPS_OUTER_RING: readonly number[] = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

export function toPx(p: Vec2, size: Size): Vec2 {
  return { x: p.x * size.width, y: p.y * size.height };
}

export function polygonFromIndices(landmarks: readonly Vec3[], indices: readonly number[], size: Size): Vec2[] {
  const out: Vec2[] = [];
  for (const i of indices) {
    const lm = landmarks[i];
    if (lm) out.push(toPx(lm, size));
  }
  return out;
}

export function faceOvalPolygon(landmarks: readonly Vec3[], size: Size): Vec2[] {
  return polygonFromIndices(landmarks, FACE_OVAL_INDICES, size);
}

export function polygonCentroid(pts: readonly Vec2[]): Vec2 {
  if (pts.length === 0) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / pts.length, y: sy / pts.length };
}

export function polygonBounds(pts: readonly Vec2[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Uniformly scale a polygon about a point (default: its vertex centroid). */
export function scalePolygon(pts: readonly Vec2[], factor: number, about: Vec2 = polygonCentroid(pts)): Vec2[] {
  return pts.map((p) => ({ x: about.x + (p.x - about.x) * factor, y: about.y + (p.y - about.y) * factor }));
}

/** Rotate `p` about `about` by `angle` radians. Screen y points down, so a positive angle is clockwise on screen. */
export function rotateAbout(p: Vec2, angle: number, about: Vec2): Vec2 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = p.x - about.x, dy = p.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
}

/** Horizontal span of a polygon at scan line `y` (0 when the line misses). Edge endpoints are inclusive. */
export function polygonWidthAt(pts: readonly Vec2[], y: number): number {
  let minX = Infinity, maxX = -Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
    if (y < lo - 1e-9 || y > hi + 1e-9) continue;
    if (Math.abs(b.y - a.y) < 1e-12) { // horizontal edge: both ends count
      minX = Math.min(minX, a.x, b.x); maxX = Math.max(maxX, a.x, b.x); continue;
    }
    const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
  }
  return isFinite(minX) ? maxX - minX : 0;
}

export type ScreenSide = 'left' | 'right';

export interface EyeMetrics {
  /** Iris centre (px). */
  center: Vec2;
  /** Outer↔inner corner distance (px) — the natural unit for every eye-attached shape. */
  width: number;
  /** Top↔bottom lid distance (px), already reflects the actual lid aperture. */
  height: number;
  /** 0..1 openness from the tracker (blendshape-derived, smoothed by W3). */
  open: number;
  /** Angle (rad) of the inner→outer eye axis on screen; ≈ head roll for a frontal face. */
  angle: number;
  /** Eye contour ring in px (16 points). */
  ring: Vec2[];
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Metrics for the eye on a given SCREEN side. The mesh's anatomical left/right flips under
 * mirroring, so we resolve side by comparing the two ring centroids' x — robust either way.
 */
export function eyeMetrics(face: FaceTrack, side: ScreenSide, size: Size): EyeMetrics {
  const lm = face.landmarks;
  const ringA = polygonFromIndices(lm, RIGHT_EYE_RING, size); // mesh-right (33 …)
  const ringB = polygonFromIndices(lm, LEFT_EYE_RING, size);  // mesh-left (263 …)
  const aIsScreenLeft = polygonCentroid(ringA).x <= polygonCentroid(ringB).x;
  const useA = side === 'left' ? aIsScreenLeft : !aIsScreenLeft;
  const idx = useA
    ? { outer: FACE_LM.RIGHT_EYE_OUTER, inner: FACE_LM.RIGHT_EYE_INNER, top: FACE_LM.RIGHT_EYE_TOP, bottom: FACE_LM.RIGHT_EYE_BOTTOM, iris: FACE_LM.RIGHT_IRIS_CENTER }
    : { outer: FACE_LM.LEFT_EYE_OUTER, inner: FACE_LM.LEFT_EYE_INNER, top: FACE_LM.LEFT_EYE_TOP, bottom: FACE_LM.LEFT_EYE_BOTTOM, iris: FACE_LM.LEFT_IRIS_CENTER };
  const ring = useA ? ringA : ringB;
  const get = (i: number): Vec2 | null => { const v = lm[i]; return v ? toPx(v, size) : null; };
  const outer = get(idx.outer), inner = get(idx.inner), top = get(idx.top), bottom = get(idx.bottom);
  const iris = get(idx.iris);
  const center = iris ?? polygonCentroid(ring);
  const width = outer && inner ? dist(outer, inner) : polygonBounds(ring).w;
  const height = top && bottom ? dist(top, bottom) : polygonBounds(ring).h;
  const angle = outer && inner ? Math.atan2(outer.y - inner.y, outer.x - inner.x) + (side === 'left' ? Math.PI : 0) : face.roll;
  return { center, width, height, open: side === 'left' ? face.eyeOpenLeft : face.eyeOpenRight, angle, ring };
}

/** Cubic-bezier path: `start`, then segments of [control1, control2, end]. */
export interface LensPath {
  start: Vec2;
  segments: Array<[Vec2, Vec2, Vec2]>;
  /** The pointed outer tip (for tests/decoration). */
  tip: Vec2;
  center: Vec2;
}

/** Teardrop lens outline in eye-width units: rounded inner end at -0.75, pointed outer tip at +1.15. */
const LENS_LOCAL = {
  start: { x: -0.75, y: 0 },
  segments: [
    [{ x: -0.75, y: -0.36 }, { x: -0.35, y: -0.56 }, { x: 0.1, y: -0.56 }],
    [{ x: 0.55, y: -0.56 }, { x: 0.98, y: -0.34 }, { x: 1.15, y: -0.1 }],   // → tip
    [{ x: 0.98, y: 0.1 }, { x: 0.55, y: 0.48 }, { x: 0.1, y: 0.48 }],
    [{ x: -0.35, y: 0.48 }, { x: -0.75, y: 0.3 }, { x: -0.75, y: 0 }],
  ] as Array<[Vec2, Vec2, Vec2]>,
  tipIndex: 1,
};

/** Upward tilt of the lens' long axis (towards the temple), radians. */
export const LENS_TILT = 0.38;

/**
 * Masked-persona eye lens. Built in a local frame along +x, tilted up by LENS_TILT, mirrored for the
 * screen-left eye, then rotated by head roll about the eye centre. `scale` multiplies eye width.
 */
export function lensShape(eye: Pick<EyeMetrics, 'center' | 'width'>, side: ScreenSide, roll: number, scale = 1): LensPath {
  const w = eye.width * scale;
  const outward = side === 'left' ? -1 : 1;
  const ct = Math.cos(-LENS_TILT), st = Math.sin(-LENS_TILT);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const map = (p: Vec2): Vec2 => {
    // 1) tilt in local frame (tip goes up: negative y)
    const tx = p.x * ct - p.y * st, ty = p.x * st + p.y * ct;
    // 2) mirror for screen-left so the tip points to the temple, 3) scale to px
    const mx = tx * outward * w, my = ty * w;
    // 4) head roll, 5) translate to eye centre
    return { x: eye.center.x + mx * cr - my * sr, y: eye.center.y + mx * sr + my * cr };
  };
  const segments = LENS_LOCAL.segments.map(([c1, c2, e]) => [map(c1), map(c2), map(e)] as [Vec2, Vec2, Vec2]);
  return { start: map(LENS_LOCAL.start), segments, tip: segments[LENS_LOCAL.tipIndex]![2], center: eye.center };
}

/** All anchor and control points of a lens path, in path order (used for tests and bounds). */
export function lensPoints(path: LensPath): Vec2[] {
  const out: Vec2[] = [path.start];
  for (const [c1, c2, e] of path.segments) out.push(c1, c2, e);
  return out;
}

/** Proportions of the suit torso relative to the face box (px). */
export const TORSO = {
  /** Shoulder half-width as a multiple of face width (total 1.6×, contract §W6). */
  shoulderHalf: 0.8,
  /** Shoulder line below the chin, as a multiple of face height. */
  shoulderDrop: 0.45,
  /** Neck half-width as a multiple of face width. */
  neckHalf: 0.42,
  /** Neck point below the chin, as a multiple of face height. */
  neckDrop: 0.16,
} as const;

/** Jaw portion of the face oval: screen-right cheek (323) → chin → screen-left cheek (93); all below the eye line. */
export const JAW_INDICES: readonly number[] = FACE_OVAL_INDICES.slice(9, 28);

/**
 * Suit torso polygon (px): jaw line (follows the landmarks, so it hugs the real chin even when
 * the head rolls) → neck → horizontal shoulders 1.6× face width → canvas bottom. The body is not
 * rolled with the head: shoulders stay level, which is what a seated person looks like.
 */
export function torsoPolygon(face: FaceTrack, size: Size): Vec2[] {
  const jaw = polygonFromIndices(face.landmarks, JAW_INDICES, size);
  const chin = toPx(face.chin, size);
  const faceW = face.faceBox.w * size.width;
  const faceH = face.faceBox.h * size.height;
  const neckY = chin.y + TORSO.neckDrop * faceH;
  const shoulderY = chin.y + TORSO.shoulderDrop * faceH;
  const sx = TORSO.shoulderHalf * faceW, nx = TORSO.neckHalf * faceW;
  const bottom = size.height;
  // jaw runs screen-right → screen-left (see JAW_INDICES); continue counter-clockwise on screen.
  return [
    ...jaw,
    { x: chin.x - nx, y: neckY },
    { x: chin.x - sx, y: shoulderY },
    { x: chin.x - sx, y: bottom },
    { x: chin.x + sx, y: bottom },
    { x: chin.x + sx, y: shoulderY },
    { x: chin.x + nx, y: neckY },
  ];
}

/** Ellipse description used by eye accents / blush. */
export interface EllipseSpec { cx: number; cy: number; rx: number; ry: number; rotation: number }

/** Mouth metrics (px): corners, lips, centre, width/height, axis angle. */
export function mouthMetrics(face: FaceTrack, size: Size): { left: Vec2; right: Vec2; upper: Vec2; lower: Vec2; center: Vec2; width: number; height: number; angle: number; ring: Vec2[] } {
  const lm = face.landmarks;
  const g = (i: number, fb: Vec2): Vec2 => { const v = lm[i]; return v ? toPx(v, size) : fb; };
  const nose = toPx(face.noseTip, size);
  const left = g(FACE_LM.MOUTH_LEFT, nose), right = g(FACE_LM.MOUTH_RIGHT, nose);
  const upper = g(FACE_LM.UPPER_LIP, nose), lower = g(FACE_LM.LOWER_LIP, nose);
  const center = { x: (left.x + right.x) / 2, y: (upper.y + lower.y) / 2 };
  return {
    left, right, upper, lower, center,
    width: dist(left, right), height: dist(upper, lower),
    angle: Math.atan2(right.y - left.y, right.x - left.x),
    ring: polygonFromIndices(lm, LIPS_OUTER_RING, size),
  };
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
