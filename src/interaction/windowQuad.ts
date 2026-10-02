/**
 * W7 — hand-window quad geometry (pure).
 *
 * Corners come from the index fingertip and thumb tip of the two best hands
 * (reference-analysis §2.1). Everything is in normalized display space.
 */
import type { HandTrack, InteractionSettings, QuadCorners, Vec2, WindowQuad, WindowOrdering } from '../types';

/** Landmark coordinates further than this from the frame are treated as tracker garbage. */
const SANE_RANGE = 4;
/** Below this |dy| between a hand's two tips the top/bottom choice is sticky (hysteresis). */
const TOP_BOTTOM_HYSTERESIS = 0.01;
/** Orientation tests below this magnitude are considered collinear. */
const EPS = 1e-12;

export interface SelectedHands { 0: HandTrack; 1: HandTrack; length: 2 }

function isFiniteVec(v: Vec2 | undefined | null): v is Vec2 {
  return (
    !!v &&
    typeof v.x === 'number' &&
    typeof v.y === 'number' &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Math.abs(v.x) <= SANE_RANGE &&
    Math.abs(v.y) <= SANE_RANGE
  );
}

function usable(h: HandTrack | undefined | null, minScore: number): h is HandTrack {
  return (
    !!h &&
    typeof h.score === 'number' &&
    Number.isFinite(h.score) &&
    h.score >= minScore &&
    isFiniteVec(h.indexTip) &&
    isFiniteVec(h.thumbTip) &&
    isFiniteVec(h.palmCenter)
  );
}

/**
 * Picks the two best hands (score ≥ minHandScore, finite geometry) and returns them as
 * [screen-left, screen-right] by palmCenter.x. Returns null when fewer than two qualify.
 * Ties on palmCenter.x fall back to indexTip.x, then to the `side` label.
 */
export function selectHands(hands: readonly HandTrack[] | null | undefined, settings: InteractionSettings): [HandTrack, HandTrack] | null {
  if (!Array.isArray(hands)) return null;
  const minScore = Number.isFinite(settings.minHandScore) ? settings.minHandScore : 0.5;
  const good = hands.filter((h) => usable(h, minScore));
  if (good.length < 2) return null;
  // Stable sort by score desc; keep the two most confident.
  const best = good
    .map((h, i) => ({ h, i }))
    .sort((a, b) => b.h.score - a.h.score || a.i - b.i)
    .slice(0, 2)
    .map((e) => e.h);
  const a = best[0]!;
  const b = best[1]!;
  const dx = a.palmCenter.x - b.palmCenter.x;
  if (dx < 0) return [a, b];
  if (dx > 0) return [b, a];
  const dix = a.indexTip.x - b.indexTip.x;
  if (dix < 0) return [a, b];
  if (dix > 0) return [b, a];
  if (a.side === 'left' && b.side === 'right') return [a, b];
  if (a.side === 'right' && b.side === 'left') return [b, a];
  return [a, b];
}

/** Cross product sign of (b−a)×(c−a); > 0 means c is left of a→b in math orientation. */
function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Proper intersection test for segments p1–p2 and p3–p4. Shared endpoints, touching and
 * collinear overlaps are reported as NON-intersecting: adjacent quad edges always share a
 * vertex and a degenerate (zero-length) edge can never form a bow-tie.
 */
export function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (Math.abs(d1) < EPS || Math.abs(d2) < EPS || Math.abs(d3) < EPS || Math.abs(d4) < EPS) return false;
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** A quadrilateral is self-intersecting iff one pair of opposite edges crosses. */
export function isSelfIntersecting(c: QuadCorners): boolean {
  return segmentsIntersect(c[0], c[1], c[2], c[3]) || segmentsIntersect(c[1], c[2], c[3], c[0]);
}

/** Unsigned shoelace area of a polygon with 4 vertices. */
export function shoelaceArea(c: QuadCorners): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const p = c[i]!;
    const q = c[(i + 1) % 4]!;
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function copy(v: Vec2): Vec2 {
  return { x: v.x, y: v.y };
}

/**
 * Per hand, decide which tip is the top corner (smaller y). Within a small band the previous
 * assignment is kept to avoid frame-to-frame flipping when both tips sit at the same height.
 * `prevTop` / `prevBottom` are the previous corners supplied by the same hand slot.
 */
function splitTopBottom(h: HandTrack, prevTop: Vec2 | null, prevBottom: Vec2 | null): { top: Vec2; bottom: Vec2 } {
  const dy = h.indexTip.y - h.thumbTip.y;
  if (prevTop && prevBottom && Math.abs(dy) < TOP_BOTTOM_HYSTERESIS) {
    const indexAsTop = dist(h.indexTip, prevTop) + dist(h.thumbTip, prevBottom);
    const thumbAsTop = dist(h.thumbTip, prevTop) + dist(h.indexTip, prevBottom);
    return indexAsTop <= thumbAsTop ? { top: h.indexTip, bottom: h.thumbTip } : { top: h.thumbTip, bottom: h.indexTip };
  }
  // Tie (dy === 0, no history): the index finger is the top corner, matching the L pose.
  return dy <= 0 ? { top: h.indexTip, bottom: h.thumbTip } : { top: h.thumbTip, bottom: h.indexTip };
}

/** Convex (non-self-intersecting) ordering; see ten-worker-contracts W7.1. */
export function orderConvex(left: HandTrack, right: HandTrack, prev: WindowQuad | null): QuadCorners {
  const usePrev = prev && prev.ordering === 'convex' && prev.visible ? prev : null;
  const L = splitTopBottom(left, usePrev ? usePrev.corners[0] : null, usePrev ? usePrev.corners[3] : null);
  const R = splitTopBottom(right, usePrev ? usePrev.corners[1] : null, usePrev ? usePrev.corners[2] : null);
  let corners: QuadCorners = [copy(L.top), copy(R.top), copy(R.bottom), copy(L.bottom)];
  // Top edge crosses bottom edge → swap the right hand's two corners.
  if (segmentsIntersect(corners[0], corners[1], corners[2], corners[3])) {
    corners = [corners[0], corners[2], corners[1], corners[3]];
  }
  // Left vertical edge crosses right vertical edge (hands' tips straddle each other) → the only
  // remaining simple cyclic order of the four points is [L.top, R.top, L.bottom, R.bottom].
  if (segmentsIntersect(corners[1], corners[2], corners[3], corners[0])) {
    corners = [corners[0], corners[1], corners[3], corners[2]];
  }
  return corners;
}

/** Faithful ordering: reproduces the reference bow-tie when hands are at very different heights. */
export function orderFaithful(left: HandTrack, right: HandTrack): QuadCorners {
  return [copy(left.indexTip), copy(right.indexTip), copy(right.thumbTip), copy(left.thumbTip)];
}

/**
 * Builds the window quad for the current frame, or null when two usable hands are not present.
 * `prev` is only used for top/bottom hysteresis in convex mode; `t` is carried for API symmetry
 * with the Interaction state machine (the pure geometry is time-independent).
 */
export function computeWindowQuad(
  hands: readonly HandTrack[] | null | undefined,
  settings: InteractionSettings,
  prev: WindowQuad | null,
  _t: number,
): WindowQuad | null {
  const pair = selectHands(hands, settings);
  if (!pair) return null;
  const [left, right] = pair;
  const ordering: WindowOrdering = settings.ordering === 'faithful' ? 'faithful' : 'convex';
  const corners = ordering === 'faithful' ? orderFaithful(left, right) : orderConvex(left, right, prev);
  // Thickness = mean length of the two per-hand segments (independent of ordering).
  const thickness = (dist(left.indexTip, left.thumbTip) + dist(right.indexTip, right.thumbTip)) / 2;
  const area = shoelaceArea(corners);
  // Vertex mean: well-defined even when area → 0 (hands together), unlike the polygon centroid.
  const centroid: Vec2 = {
    x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
    y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4,
  };
  return { corners, opacity: 1, thickness, area, centroid, visible: true, ordering };
}
