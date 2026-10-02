import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERACTION_SETTINGS } from '../../../src/types';
import type { HandTrack, InteractionSettings, Vec2 } from '../../../src/types';
import {
  computeWindowQuad,
  isSelfIntersecting,
  segmentsIntersect,
  shoelaceArea,
  selectHands,
} from '../../../src/interaction/windowQuad';
import { crossedHands, lPoseHands, makeHand, near, rng, thumbsUpHands } from './helpers';

const S: InteractionSettings = { ...DEFAULT_INTERACTION_SETTINGS };
const faithful: InteractionSettings = { ...S, ordering: 'faithful' };

describe('segmentsIntersect', () => {
  it('detects a proper crossing', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 })).toBe(true);
  });
  it('rejects parallel / disjoint segments', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBe(false);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 1, y: 0 })).toBe(false);
  });
  it('treats shared endpoints as non-crossing (adjacent quad edges)', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });
  it('handles zero-length (degenerate) segments without throwing', () => {
    expect(segmentsIntersect({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });
});

describe('shoelaceArea', () => {
  it('unit square → 1, independent of winding', () => {
    const cw: [Vec2, Vec2, Vec2, Vec2] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const ccw: [Vec2, Vec2, Vec2, Vec2] = [cw[0], cw[3], cw[2], cw[1]];
    expect(shoelaceArea(cw)).toBeCloseTo(1, 12);
    expect(shoelaceArea(ccw)).toBeCloseTo(1, 12);
  });
  it('collinear points → 0', () => {
    expect(shoelaceArea([{ x: 0, y: 0 }, { x: 0.3, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 1, y: 1 }])).toBe(0);
  });
});

describe('selectHands', () => {
  it('needs two hands with score ≥ minHandScore', () => {
    const [l, r] = lPoseHands();
    expect(selectHands([l], S)).toBeNull();
    expect(selectHands([l, { ...r, score: 0.3 }], S)).toBeNull();
    expect(selectHands([l, r], S)).not.toBeNull();
  });
  it('returns [left, right] by palmCenter.x regardless of input order or `side` label', () => {
    const [l, r] = lPoseHands();
    const res = selectHands([{ ...r, side: 'left' }, { ...l, side: 'right' }], S);
    expect(res).not.toBeNull();
    expect(res![0].palmCenter.x).toBeLessThan(res![1].palmCenter.x);
  });
  it('picks the two highest-scoring hands when more than two are supplied', () => {
    const [l, r] = lPoseHands();
    const ghost = makeHand({ indexTip: { x: 0.5, y: 0.1 }, thumbTip: { x: 0.5, y: 0.2 }, palmCenter: { x: 0.5, y: 0.5 }, score: 0.55 });
    const res = selectHands([ghost, l, r], S);
    expect(res!.map((h) => h.palmCenter.x)).toEqual([l.palmCenter.x, r.palmCenter.x]);
  });
  it('rejects hands with non-numeric tips or palm', () => {
    const [l, r] = lPoseHands();
    const bad: HandTrack = { ...r, indexTip: { x: Number.NaN, y: 0.3 } };
    expect(selectHands([l, bad], S)).toBeNull();
    const bad2: HandTrack = { ...r, palmCenter: { x: Number.POSITIVE_INFINITY, y: 0.5 } };
    expect(selectHands([l, bad2], S)).toBeNull();
  });
  it('tolerates a null-ish hands list', () => {
    expect(selectHands([], S)).toBeNull();
    expect(selectHands(null as unknown as HandTrack[], S)).toBeNull();
  });
});

describe('computeWindowQuad — convex ordering', () => {
  it('returns null with fewer than two usable hands', () => {
    const [l] = lPoseHands();
    expect(computeWindowQuad([], S, null, 0)).toBeNull();
    expect(computeWindowQuad([l], S, null, 0)).toBeNull();
  });

  it('L-pose: corners are exactly the tips, TL/BL from the screen-left hand', () => {
    const [l, r] = lPoseHands();
    const q = computeWindowQuad([l, r], S, null, 0)!;
    expect(q).not.toBeNull();
    expect(q.corners[0]).toEqual(l.indexTip); // TL
    expect(q.corners[1]).toEqual(r.indexTip); // TR
    expect(q.corners[2]).toEqual(r.thumbTip); // BR
    expect(q.corners[3]).toEqual(l.thumbTip); // BL
    expect(q.ordering).toBe('convex');
    expect(q.visible).toBe(true);
    expect(q.opacity).toBe(1);
  });

  it('L-pose: input order of the hands does not matter', () => {
    const [l, r] = lPoseHands();
    const a = computeWindowQuad([l, r], S, null, 0)!;
    const b = computeWindowQuad([r, l], S, null, 0)!;
    expect(b.corners).toEqual(a.corners);
  });

  it('thumbs-up pose flips: thumbs become the top edge', () => {
    const [l, r] = thumbsUpHands();
    const q = computeWindowQuad([l, r], S, null, 0)!;
    expect(q.corners[0]).toEqual(l.thumbTip);
    expect(q.corners[1]).toEqual(r.thumbTip);
    expect(q.corners[2]).toEqual(r.indexTip);
    expect(q.corners[3]).toEqual(l.indexTip);
  });

  it('crossed case is un-crossed (no self-intersection) and keeps all four tips', () => {
    const [l, r] = crossedHands();
    const q = computeWindowQuad([l, r], S, null, 0)!;
    expect(isSelfIntersecting(q.corners)).toBe(false);
    const tips = [l.indexTip, l.thumbTip, r.indexTip, r.thumbTip];
    for (const tip of tips) expect(q.corners.some((c) => near(c, tip))).toBe(true);
    // Area of the un-crossed rectangle 0.6 × 0.6
    expect(q.area).toBeCloseTo(0.36, 9);
  });

  it('thickness is the mean of the two vertical edge lengths', () => {
    const [l, r] = lPoseHands();
    const q = computeWindowQuad([l, r], S, null, 0)!;
    const dl = Math.hypot(l.indexTip.x - l.thumbTip.x, l.indexTip.y - l.thumbTip.y);
    const dr = Math.hypot(r.indexTip.x - r.thumbTip.x, r.indexTip.y - r.thumbTip.y);
    expect(q.thickness).toBeCloseTo((dl + dr) / 2, 12);
  });

  it('area is the shoelace magnitude and centroid is the vertex mean', () => {
    const l = makeHand({ indexTip: { x: 0.2, y: 0.2 }, thumbTip: { x: 0.2, y: 0.7 }, palmCenter: { x: 0.1, y: 0.5 } });
    const r = makeHand({ indexTip: { x: 0.8, y: 0.2 }, thumbTip: { x: 0.8, y: 0.7 }, palmCenter: { x: 0.9, y: 0.5 } });
    const q = computeWindowQuad([l, r], S, null, 0)!;
    expect(q.area).toBeCloseTo(0.6 * 0.5, 12);
    expect(q.centroid.x).toBeCloseTo(0.5, 12);
    expect(q.centroid.y).toBeCloseTo(0.45, 12);
  });

  it('degenerate (all tips coincident) yields a zero-area quad, never NaN', () => {
    const p = { x: 0.5, y: 0.5 };
    const l = makeHand({ indexTip: p, thumbTip: p, palmCenter: { x: 0.45, y: 0.5 } });
    const r = makeHand({ indexTip: p, thumbTip: p, palmCenter: { x: 0.55, y: 0.5 } });
    const q = computeWindowQuad([l, r], S, null, 0)!;
    expect(q.area).toBe(0);
    expect(q.thickness).toBe(0);
    expect(Number.isFinite(q.centroid.x)).toBe(true);
    for (const c of q.corners) expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
  });

  it('top/bottom choice is sticky near equal heights when prev is supplied (hysteresis)', () => {
    // Left hand: index clearly above thumb; then thumb creeps 1e-4 above index.
    const l0 = makeHand({ indexTip: { x: 0.2, y: 0.40 }, thumbTip: { x: 0.25, y: 0.60 }, palmCenter: { x: 0.15, y: 0.5 } });
    const r = makeHand({ indexTip: { x: 0.8, y: 0.30 }, thumbTip: { x: 0.75, y: 0.60 }, palmCenter: { x: 0.85, y: 0.5 } });
    const prev = computeWindowQuad([l0, r], S, null, 0)!;
    const l1 = makeHand({ indexTip: { x: 0.2, y: 0.5001 }, thumbTip: { x: 0.25, y: 0.5 }, palmCenter: { x: 0.15, y: 0.5 } });
    const q = computeWindowQuad([l1, r], S, prev, 16)!;
    expect(q.corners[0]).toEqual(l1.indexTip); // still treated as top
    // Without prev the strict rule applies: thumb is top.
    const q2 = computeWindowQuad([l1, r], S, null, 16)!;
    expect(q2.corners[0]).toEqual(l1.thumbTip);
  });
});

describe('computeWindowQuad — faithful ordering', () => {
  it('uses the fixed [L.index, R.index, R.thumb, L.thumb] order', () => {
    const [l, r] = thumbsUpHands();
    const q = computeWindowQuad([l, r], faithful, null, 0)!;
    expect(q.corners).toEqual([l.indexTip, r.indexTip, r.thumbTip, l.thumbTip]);
    expect(q.ordering).toBe('faithful');
  });
  it('keeps the bow-tie in the crossed case', () => {
    const [l, r] = crossedHands();
    const q = computeWindowQuad([l, r], faithful, null, 0)!;
    expect(isSelfIntersecting(q.corners)).toBe(true);
  });
});

describe('computeWindowQuad — property tests (seeded)', () => {
  const random = rng(20261002);
  const randomHands = (): [HandTrack, HandTrack] => {
    const p = (): Vec2 => ({ x: random() * 1.2 - 0.1, y: random() * 1.2 - 0.1 });
    const a = makeHand({ indexTip: p(), thumbTip: p(), palmCenter: p() });
    const b = makeHand({ indexTip: p(), thumbTip: p(), palmCenter: p() });
    return [a, b];
  };

  it('convex ordering never self-intersects; both orderings preserve the tip multiset and area/centroid finite', () => {
    for (let i = 0; i < 2000; i++) {
      const [a, b] = randomHands();
      if (a.palmCenter.x === b.palmCenter.x) continue;
      const q = computeWindowQuad([a, b], S, null, i)!;
      const f = computeWindowQuad([a, b], faithful, null, i)!;
      expect(q).not.toBeNull();
      expect(isSelfIntersecting(q.corners)).toBe(false);
      const tips = [a.indexTip, a.thumbTip, b.indexTip, b.thumbTip];
      for (const tip of tips) {
        expect(q.corners.some((c) => near(c, tip))).toBe(true);
        expect(f.corners.some((c) => near(c, tip))).toBe(true);
      }
      expect(Number.isFinite(q.area) && q.area >= 0).toBe(true);
      expect(Number.isFinite(q.thickness) && q.thickness >= 0).toBe(true);
      expect(Number.isFinite(q.centroid.x) && Number.isFinite(q.centroid.y)).toBe(true);
      // Thickness is ordering-independent (same two per-hand segments).
      expect(f.thickness).toBeCloseTo(q.thickness, 12);
    }
  });

  it('TL/BL always come from the screen-left hand (convex)', () => {
    for (let i = 0; i < 500; i++) {
      const [a, b] = randomHands();
      if (a.palmCenter.x === b.palmCenter.x) continue;
      const [l, r] = a.palmCenter.x < b.palmCenter.x ? [a, b] : [b, a];
      const q = computeWindowQuad([a, b], S, null, i)!;
      const fromL = (c: Vec2) => near(c, l.indexTip) || near(c, l.thumbTip);
      const fromR = (c: Vec2) => near(c, r.indexTip) || near(c, r.thumbTip);
      // After un-crossing, the two L tips occupy two corners and the two R tips the other two —
      // never mixed within a single hand slot.
      const lCount = q.corners.filter(fromL).length;
      const rCount = q.corners.filter(fromR).length;
      expect(lCount).toBe(2);
      expect(rCount).toBe(2);
    }
  });

  it('never emits NaN for adversarial numeric input', () => {
    const weird = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e308, -1e308, 0];
    for (const wx of weird) {
      const l = makeHand({ indexTip: { x: wx, y: 0.3 }, thumbTip: { x: 0.3, y: 0.6 }, palmCenter: { x: 0.2, y: 0.5 } });
      const r = makeHand({ indexTip: { x: 0.8, y: 0.3 }, thumbTip: { x: 0.7, y: 0.6 }, palmCenter: { x: 0.8, y: 0.5 } });
      const q = computeWindowQuad([l, r], S, null, 0);
      if (q) {
        for (const c of q.corners) expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
        expect(Number.isFinite(q.area)).toBe(true);
      }
    }
  });
});
