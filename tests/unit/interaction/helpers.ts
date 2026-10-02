/**
 * Synthetic tracking fixtures for W7 interaction tests. Pure data builders — no DOM.
 * Coordinates are normalized display space (origin top-left, y down).
 */
import type { HandTrack, HandSide, TrackingFrame, Vec2, Vec3 } from '../../../src/types';
import { HAND_LM } from '../../../src/types';

export interface HandSpec {
  side?: HandSide;
  indexTip: Vec2;
  thumbTip: Vec2;
  palmCenter?: Vec2;
  score?: number;
  size?: number;
}

/** Builds a HandTrack with 21 landmarks; only tips / palm are meaningful, the rest sit at the palm. */
export function makeHand(spec: HandSpec): HandTrack {
  const palm = spec.palmCenter ?? {
    x: (spec.indexTip.x + spec.thumbTip.x) / 2,
    y: (spec.indexTip.y + spec.thumbTip.y) / 2 + 0.08,
  };
  const landmarks: Vec3[] = Array.from({ length: 21 }, () => ({ x: palm.x, y: palm.y, z: 0 }));
  landmarks[HAND_LM.INDEX_TIP] = { ...spec.indexTip, z: 0 };
  landmarks[HAND_LM.THUMB_TIP] = { ...spec.thumbTip, z: 0 };
  landmarks[HAND_LM.WRIST] = { x: palm.x, y: palm.y + 0.06, z: 0 };
  return {
    side: spec.side ?? (palm.x < 0.5 ? 'left' : 'right'),
    landmarks,
    score: spec.score ?? 0.95,
    indexTip: { ...spec.indexTip },
    thumbTip: { ...spec.thumbTip },
    palmCenter: { ...palm },
    size: spec.size ?? 0.12,
  };
}

/** Classic "L" pose: index up (top corner), thumb below/inward (bottom corner). */
export function lPoseHands(): [HandTrack, HandTrack] {
  const left = makeHand({ side: 'left', indexTip: { x: 0.25, y: 0.30 }, thumbTip: { x: 0.30, y: 0.60 } });
  const right = makeHand({ side: 'right', indexTip: { x: 0.75, y: 0.32 }, thumbTip: { x: 0.70, y: 0.62 } });
  return [left, right];
}

/** Thumbs-up pose: thumb tip is ABOVE the index tip on both hands. */
export function thumbsUpHands(): [HandTrack, HandTrack] {
  const left = makeHand({ side: 'left', indexTip: { x: 0.30, y: 0.60 }, thumbTip: { x: 0.25, y: 0.30 } });
  const right = makeHand({ side: 'right', indexTip: { x: 0.70, y: 0.62 }, thumbTip: { x: 0.75, y: 0.32 } });
  return [left, right];
}

/**
 * Crossing case (reference f01250–f01290 "bow-tie"): left hand's top is low on screen, right hand's
 * top is high, such that top edge (L.top→R.top) and bottom edge (L.bottom→R.bottom) intersect
 * when corners are taken in the naive [L.index, R.index, R.thumb, L.thumb] order.
 */
export function crossedHands(): [HandTrack, HandTrack] {
  // Left: index at (0.2,0.2), thumb at (0.2,0.8). Right: index at (0.8,0.8), thumb at (0.8,0.2).
  // Naive order [L.index(0.2,0.2), R.index(0.8,0.8), R.thumb(0.8,0.2), L.thumb(0.2,0.8)]
  // → edges (0.2,0.2)-(0.8,0.8) and (0.8,0.2)-(0.2,0.8) cross at the centre.
  const left = makeHand({ side: 'left', indexTip: { x: 0.2, y: 0.2 }, thumbTip: { x: 0.2, y: 0.8 }, palmCenter: { x: 0.15, y: 0.5 } });
  const right = makeHand({ side: 'right', indexTip: { x: 0.8, y: 0.8 }, thumbTip: { x: 0.8, y: 0.2 }, palmCenter: { x: 0.85, y: 0.5 } });
  return [left, right];
}

export function makeFrame(hands: HandTrack[], t = 0): TrackingFrame {
  return {
    t,
    sourceWidth: 1280,
    sourceHeight: 720,
    hands: [...hands].sort((a, b) => a.palmCenter.x - b.palmCenter.x),
    face: null,
    segmentation: null,
    timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 },
  };
}

/** Deterministic PRNG (mulberry32) for property tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function near(a: Vec2, b: Vec2, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}
