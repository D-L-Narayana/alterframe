import { describe, it, expect } from 'vitest';
import {
  FACE_OVAL_INDICES, LEFT_EYE_RING, RIGHT_EYE_RING, LIPS_OUTER_RING,
  toPx, polygonFromIndices, faceOvalPolygon, polygonCentroid, scalePolygon, rotateAbout,
  eyeMetrics, lensShape, lensPoints, torsoPolygon, polygonWidthAt, polygonBounds,
} from '../../../src/render/persona/geometry';
import { makeFace, makeLandmarks, SIZE } from './fixtures';

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe('landmark rings', () => {
  it('face oval uses the 36 contract indices in order starting at the forehead (10) and passing the chin (152)', () => {
    expect(FACE_OVAL_INDICES).toHaveLength(36);
    expect(FACE_OVAL_INDICES[0]).toBe(10);
    expect(FACE_OVAL_INDICES[18]).toBe(152);
    expect(new Set(FACE_OVAL_INDICES).size).toBe(36);
  });
  it('eye and lip rings are closed loops of distinct mesh indices', () => {
    for (const ring of [LEFT_EYE_RING, RIGHT_EYE_RING, LIPS_OUTER_RING]) {
      expect(new Set(ring).size).toBe(ring.length);
      expect(ring.length).toBeGreaterThanOrEqual(16);
    }
    expect(LEFT_EYE_RING).toContain(263);
    expect(RIGHT_EYE_RING).toContain(33);
    expect(LIPS_OUTER_RING).toContain(61);
    expect(LIPS_OUTER_RING).toContain(291);
  });
});

describe('toPx / polygons', () => {
  it('maps normalized display coordinates to device pixels of the layer canvas', () => {
    expect(toPx({ x: 0.25, y: 0.5 }, SIZE)).toEqual({ x: 250, y: 250 });
  });
  it('polygonFromIndices picks the landmarks in ring order and converts to px', () => {
    const lm = makeLandmarks({ 1: { x: 0.1, y: 0.2, z: 0 }, 2: { x: 0.3, y: 0.4, z: 0 } });
    expect(polygonFromIndices(lm, [1, 2], SIZE)).toEqual([{ x: 100, y: 100 }, { x: 300, y: 200 }]);
  });
  it('faceOvalPolygon returns the 36 oval points in px and is roughly an ellipse of the synthetic face', () => {
    const face = makeFace({ cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.14 });
    const poly = faceOvalPolygon(face.landmarks, SIZE);
    expect(poly).toHaveLength(36);
    const b = polygonBounds(poly);
    expect(close(b.x, 400, 1e-6)).toBe(true);
    expect(close(b.w, 200, 1e-6)).toBe(true);
    expect(close(b.y, 180, 1e-6)).toBe(true);
    expect(close(b.h, 140, 1e-6)).toBe(true);
  });
  it('polygonCentroid of a square is its centre', () => {
    expect(polygonCentroid([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }])).toEqual({ x: 1, y: 1 });
  });
  it('scalePolygon enlarges about the centroid (1.2× keeps centre, scales extents)', () => {
    const sq = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
    const big = scalePolygon(sq, 1.2);
    expect(polygonCentroid(big)).toEqual({ x: 1, y: 1 });
    expect(big[0]!.x).toBeCloseTo(-0.2);
    expect(big[2]!.x).toBeCloseTo(2.2);
  });
  it('rotateAbout rotates a point clockwise on screen for positive angles (y down)', () => {
    const p = rotateAbout({ x: 1, y: 0 }, Math.PI / 2, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
  });
});

describe('eyeMetrics', () => {
  it('reports centre at the iris, width from outer→inner corner, in px', () => {
    const face = makeFace({ rx: 0.1, ry: 0.14 });
    const m = eyeMetrics(face, 'left', SIZE); // screen-left eye
    expect(m.center.x).toBeCloseTo(face.leftEye.x * SIZE.width);
    expect(m.center.y).toBeCloseTo(face.leftEye.y * SIZE.height);
    expect(m.width).toBeCloseTo(0.1 * 0.5 * SIZE.width); // ew = rx*0.5 normalized → px
    expect(m.open).toBe(1);
  });
  it('width is measured along the rolled face, so rolling the head keeps the same width', () => {
    const a = eyeMetrics(makeFace(), 'right', SIZE);
    const b = eyeMetrics(makeFace({ roll: 0.4 }), 'right', SIZE);
    // non-square canvas: px distances change with roll, so compare in a square canvas instead
    const sq = { width: 1000, height: 1000 };
    const a2 = eyeMetrics(makeFace(), 'right', sq);
    const b2 = eyeMetrics(makeFace({ roll: 0.4 }), 'right', sq);
    expect(b2.width).toBeCloseTo(a2.width, 6);
    expect(a.width).toBeGreaterThan(0);
    expect(b.width).toBeGreaterThan(0);
  });
});

describe('lensShape (masked persona teardrop)', () => {
  const eyeL = { center: { x: 400, y: 250 }, width: 50, height: 20, open: 1, angle: 0 };
  const eyeR = { center: { x: 600, y: 250 }, width: 50, height: 20, open: 1, angle: 0 };
  it('screen-left and screen-right lenses are exact mirror images across the midline at roll 0', () => {
    const L = lensPoints(lensShape(eyeL, 'left', 0));
    const R = lensPoints(lensShape(eyeR, 'right', 0));
    expect(L.length).toBe(R.length);
    const mid = 500;
    L.forEach((p, i) => {
      expect(p.x).toBeCloseTo(2 * mid - R[i]!.x, 6);
      expect(p.y).toBeCloseTo(R[i]!.y, 6);
    });
  });
  it('the pointed tip lies outward and above the eye centre (towards the temple, tilted up)', () => {
    const L = lensShape(eyeL, 'left', 0);
    expect(L.tip.x).toBeLessThan(eyeL.center.x);
    expect(L.tip.y).toBeLessThan(eyeL.center.y);
    const R = lensShape(eyeR, 'right', 0);
    expect(R.tip.x).toBeGreaterThan(eyeR.center.x);
    expect(R.tip.y).toBeLessThan(eyeR.center.y);
  });
  it('lens spans about 1.9× the eye width and contains the eye centre', () => {
    const L = lensShape(eyeL, 'left', 0);
    const b = polygonBounds(lensPoints(L));
    expect(b.w).toBeGreaterThan(eyeL.width * 1.6);
    expect(b.w).toBeLessThan(eyeL.width * 2.3);
    expect(b.x).toBeLessThan(eyeL.center.x);
    expect(b.x + b.w).toBeGreaterThan(eyeL.center.x);
  });
  it('rolling the head rotates the lens rigidly about the eye centre', () => {
    const roll = 0.5;
    const L0 = lensPoints(lensShape(eyeL, 'left', 0));
    const L1 = lensPoints(lensShape(eyeL, 'left', roll));
    L0.forEach((p, i) => {
      const r = rotateAbout(p, roll, eyeL.center);
      expect(L1[i]!.x).toBeCloseTo(r.x, 6);
      expect(L1[i]!.y).toBeCloseTo(r.y, 6);
    });
  });
});

describe('torsoPolygon (suit persona)', () => {
  it('starts along the jaw line below the eyes, is 1.6× face width at the shoulders and reaches the canvas bottom', () => {
    const face = makeFace({ cx: 0.5, cy: 0.4, rx: 0.1, ry: 0.14 });
    const poly = torsoPolygon(face, SIZE);
    const b = polygonBounds(poly);
    expect(b.y + b.h).toBeCloseTo(SIZE.height, 6);
    const faceWpx = face.faceBox.w * SIZE.width; // 200
    const shoulderY = poly.find((p) => Math.abs(p.x - b.x) < 1e-6)!.y;
    expect(polygonWidthAt(poly, shoulderY)).toBeCloseTo(1.6 * faceWpx, 3);
    // top edge must not cover the eyes: every vertex is below the eye line
    const eyeY = face.leftEye.y * SIZE.height;
    for (const p of poly) expect(p.y).toBeGreaterThan(eyeY);
    // the polygon is centred on the chin x
    expect((b.x + b.w / 2)).toBeCloseTo(face.chin.x * SIZE.width, 3);
  });
  it('torso width scales with the face (bigger face → wider shoulders)', () => {
    const small = polygonBounds(torsoPolygon(makeFace({ rx: 0.05, ry: 0.07 }), SIZE));
    const big = polygonBounds(torsoPolygon(makeFace({ rx: 0.1, ry: 0.14 }), SIZE));
    expect(big.w).toBeCloseTo(small.w * 2, 3);
  });
});

describe('spiderEmblem (original suit crest)', () => {
  it('has 8 legs, an oval abdomen and a head, and spans ~1.1× the requested face width', async () => {
    const { spiderEmblem } = await import('../../../src/render/persona/suitEmblem');
    const faceW = 200;
    const e = spiderEmblem({ x: 500, y: 400 }, faceW);
    expect(e.legs).toHaveLength(8);
    const xs = e.legs.flatMap((l) => [l.tip.x, l.knee.x, l.root.x]);
    const span = Math.max(...xs) - Math.min(...xs);
    expect(span).toBeGreaterThan(1.0 * faceW);
    expect(span).toBeLessThan(1.2 * faceW);
    expect(e.abdomen.ry).toBeGreaterThan(e.abdomen.rx); // oval, longer than wide
    expect(e.head.r).toBeLessThan(e.abdomen.rx);
    // legs are mirror-symmetric about the centre line
    const left = e.legs.filter((l) => l.tip.x < 500), right = e.legs.filter((l) => l.tip.x > 500);
    expect(left).toHaveLength(4); expect(right).toHaveLength(4);
  });
});
