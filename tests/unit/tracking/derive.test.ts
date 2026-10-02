import { describe, expect, it } from 'vitest';
import {
  deriveHand,
  deriveFace,
  mirrorLandmarks,
  sortHands,
  assignSides,
  matchHands,
} from '../../../src/tracking/derive';
import { HAND_LM, FACE_LM } from '../../../src/types/tracking';
import type { Vec3 } from '../../../src/types/geometry';

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

/** 21 hand landmarks: everything at `base`, with the indices we care about overridden. */
function hand(overrides: Partial<Record<number, Vec3>>, base = v(0.5, 0.5)): Vec3[] {
  const lm = Array.from({ length: 21 }, () => ({ ...base }));
  for (const [k, p] of Object.entries(overrides)) lm[Number(k)] = { ...(p as Vec3) };
  return lm;
}

/**
 * 478 face landmarks, all at the face centre, with eyes/nose/chin/forehead/mouth placed
 * on a face rotated by `roll` radians (screen-clockwise) around the centre.
 */
function face(opts: { cx?: number; cy?: number; roll?: number; eyeGap?: number; mouthGap?: number; mouthW?: number } = {}): Vec3[] {
  const { cx = 0.5, cy = 0.5, roll = 0, eyeGap = 0.03, mouthGap = 0.0, mouthW = 0.1 } = opts;
  const lm = Array.from({ length: 478 }, () => v(cx, cy));
  const rot = (dx: number, dy: number): Vec3 => ({
    x: cx + dx * Math.cos(roll) - dy * Math.sin(roll),
    y: cy + dx * Math.sin(roll) + dy * Math.cos(roll),
    z: 0,
  });
  // Un-mirrored image: subject's RIGHT eye (33/133/159/145/468) is on image-left (dx < 0).
  const set = (i: number, p: Vec3) => { lm[i] = p; };
  set(FACE_LM.RIGHT_EYE_OUTER, rot(-0.15, -0.1));
  set(FACE_LM.RIGHT_EYE_INNER, rot(-0.05, -0.1));
  set(FACE_LM.RIGHT_EYE_TOP, rot(-0.1, -0.1 - eyeGap / 2));
  set(FACE_LM.RIGHT_EYE_BOTTOM, rot(-0.1, -0.1 + eyeGap / 2));
  set(FACE_LM.RIGHT_IRIS_CENTER, rot(-0.1, -0.1));
  set(FACE_LM.LEFT_EYE_OUTER, rot(0.15, -0.1));
  set(FACE_LM.LEFT_EYE_INNER, rot(0.05, -0.1));
  set(FACE_LM.LEFT_EYE_TOP, rot(0.1, -0.1 - eyeGap / 2));
  set(FACE_LM.LEFT_EYE_BOTTOM, rot(0.1, -0.1 + eyeGap / 2));
  set(FACE_LM.LEFT_IRIS_CENTER, rot(0.1, -0.1));
  set(FACE_LM.NOSE_TIP, rot(0, 0.02));
  set(FACE_LM.CHIN, rot(0, 0.25));
  set(FACE_LM.FOREHEAD, rot(0, -0.25));
  set(FACE_LM.MOUTH_RIGHT, rot(-mouthW / 2, 0.15)); // subject's right corner → image-left
  set(FACE_LM.MOUTH_LEFT, rot(mouthW / 2, 0.15));
  set(FACE_LM.UPPER_LIP, rot(0, 0.15 - mouthGap / 2));
  set(FACE_LM.LOWER_LIP, rot(0, 0.15 + mouthGap / 2));
  return lm;
}

describe('mirrorLandmarks', () => {
  it('maps x → 1 - x and leaves y/z untouched', () => {
    const out = mirrorLandmarks([v(0.2, 0.3, 0.1), v(1, 0, -1)]);
    expect(out[0]).toEqual(v(0.8, 0.3, 0.1));
    expect(out[1]).toEqual(v(0, 0, -1));
  });
  it('writes into the provided output array when given', () => {
    const dst: Vec3[] = [];
    const src = [v(0.25, 0.5)];
    const out = mirrorLandmarks(src, dst);
    expect(out).toBe(dst);
    expect(dst[0]!.x).toBeCloseTo(0.75);
  });
});

describe('deriveHand', () => {
  it('copies index/thumb tips and averages the palm landmarks', () => {
    const lm = hand({
      [HAND_LM.INDEX_TIP]: v(0.2, 0.1),
      [HAND_LM.THUMB_TIP]: v(0.25, 0.4),
      [HAND_LM.WRIST]: v(0.3, 0.6),
      [HAND_LM.INDEX_MCP]: v(0.2, 0.4),
      [HAND_LM.MIDDLE_MCP]: v(0.3, 0.4),
      13: v(0.4, 0.4),
      [HAND_LM.PINKY_MCP]: v(0.5, 0.4),
    });
    const h = deriveHand(lm, 0.9, 'left', 1);
    expect(h.side).toBe('left');
    expect(h.score).toBe(0.9);
    expect(h.indexTip).toEqual({ x: 0.2, y: 0.1 });
    expect(h.thumbTip).toEqual({ x: 0.25, y: 0.4 });
    expect(h.palmCenter.x).toBeCloseTo((0.3 + 0.2 + 0.3 + 0.4 + 0.5) / 5);
    expect(h.palmCenter.y).toBeCloseTo((0.6 + 0.4 * 4) / 5);
    expect(h.landmarks).toHaveLength(21);
  });

  it('size = wrist→middle-MCP distance in units of frame height (aspect-corrected)', () => {
    const lm = hand({ [HAND_LM.WRIST]: v(0.5, 0.5), [HAND_LM.MIDDLE_MCP]: v(0.6, 0.5) });
    // 0.1 of width at 16:9 equals 0.1 * 16/9 of height
    expect(deriveHand(lm, 1, 'left', 16 / 9).size).toBeCloseTo(0.1 * (16 / 9));
    const lm2 = hand({ [HAND_LM.WRIST]: v(0.5, 0.5), [HAND_LM.MIDDLE_MCP]: v(0.5, 0.7) });
    expect(deriveHand(lm2, 1, 'left', 16 / 9).size).toBeCloseTo(0.2);
  });

  it('clamps the score into [0,1]', () => {
    expect(deriveHand(hand({}), 1.4, 'right').score).toBe(1);
    expect(deriveHand(hand({}), -0.2, 'right').score).toBe(0);
  });
});

describe('sortHands / assignSides', () => {
  it('sorts by palmCenter.x ascending and assigns side by screen position', () => {
    const a = deriveHand(hand({}, v(0.8, 0.5)), 1, 'left');
    const b = deriveHand(hand({}, v(0.2, 0.5)), 1, 'left');
    const sorted = assignSides(sortHands([a, b]));
    expect(sorted[0]!.palmCenter.x).toBeCloseTo(0.2);
    expect(sorted[0]!.side).toBe('left');
    expect(sorted[1]!.side).toBe('right');
  });
  it('a single hand gets its side from which half of the screen it is on', () => {
    expect(assignSides([deriveHand(hand({}, v(0.7, 0.5)), 1, 'left')])[0]!.side).toBe('right');
    expect(assignSides([deriveHand(hand({}, v(0.3, 0.5)), 1, 'left')])[0]!.side).toBe('left');
  });
});

describe('matchHands', () => {
  it('keeps smoother slots stable when hands swap detection order', () => {
    const prev = [v(0.2, 0.5), v(0.8, 0.5)];               // slot 0 at left, slot 1 at right
    const cur = [v(0.82, 0.5), v(0.21, 0.5)];              // detector returned right hand first
    expect(matchHands(prev, cur)).toEqual([1, 0]);         // current[0] → slot 1, current[1] → slot 0
  });
  it('assigns a free slot to a new hand', () => {
    expect(matchHands([v(0.2, 0.5), null], [v(0.8, 0.5), v(0.2, 0.5)])).toEqual([1, 0]);
  });
  it('handles empty previous', () => {
    expect(matchHands([null, null], [v(0.2, 0.5)])).toEqual([0]);
  });
});

describe('deriveFace', () => {
  it('computes eye centres from the 4 eye landmarks; screen-left eye has the smaller x', () => {
    const f = deriveFace(face(), {}, null, 1);
    expect(f.leftEye.x).toBeLessThan(f.rightEye.x);
    // un-mirrored: subject's right eye (image-left, x = 0.4) is the screen-left eye
    expect(f.leftEye.x).toBeCloseTo(0.4);
    expect(f.leftEye.y).toBeCloseTo(0.4);
    expect(f.rightEye.x).toBeCloseTo(0.6);
  });

  it('after mirroring, screen-left is still the smaller-x eye and blendshapes follow the swap', () => {
    const mirrored = mirrorLandmarks(face());
    const f = deriveFace(mirrored, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1 }, null, 1);
    expect(f.leftEye.x).toBeLessThan(f.rightEye.x);
    // Mirrored: subject's LEFT eye (blendshape eyeBlinkLeft) is now on screen-left → mostly closed.
    expect(f.eyeOpenLeft).toBeCloseTo(0.1);
    expect(f.eyeOpenRight).toBeCloseTo(0.9);
  });

  it('un-mirrored: subject left eye is on screen-right, so eyeBlinkLeft drives eyeOpenRight', () => {
    const f = deriveFace(face(), { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1 }, null, 1);
    expect(f.eyeOpenRight).toBeCloseTo(0.1);
    expect(f.eyeOpenLeft).toBeCloseTo(0.9);
  });

  it('roll is positive for a clockwise tilt and negative for counter-clockwise, ±20°', () => {
    const cw = deriveFace(face({ roll: 20 * Math.PI / 180 }), {}, null, 1);
    const ccw = deriveFace(face({ roll: -20 * Math.PI / 180 }), {}, null, 1);
    expect(cw.roll).toBeCloseTo(20 * Math.PI / 180, 3);
    expect(ccw.roll).toBeCloseTo(-20 * Math.PI / 180, 3);
    expect(deriveFace(face(), {}, null, 1).roll).toBeCloseTo(0, 6);
  });

  it('mirroring flips the sign of roll', () => {
    const lm = face({ roll: 0.3 });
    const a = deriveFace(lm, {}, null, 1).roll;
    const b = deriveFace(mirrorLandmarks(lm), {}, null, 1).roll;
    expect(b).toBeCloseTo(-a, 6);
  });

  it('roll is aspect-corrected (a 16:9 frame squashes normalized y)', () => {
    // A 45° screen tilt in a 16:9 frame: dy_norm = dx_norm * aspect.
    const lm = face();
    const aspect = 16 / 9;
    lm[FACE_LM.RIGHT_EYE_OUTER] = v(0.4, 0.3); lm[FACE_LM.RIGHT_EYE_INNER] = v(0.4, 0.3);
    lm[FACE_LM.RIGHT_EYE_TOP] = v(0.4, 0.3); lm[FACE_LM.RIGHT_EYE_BOTTOM] = v(0.4, 0.3);
    const dx = 0.1;
    lm[FACE_LM.LEFT_EYE_OUTER] = v(0.5, 0.3 + dx * aspect); lm[FACE_LM.LEFT_EYE_INNER] = v(0.5, 0.3 + dx * aspect);
    lm[FACE_LM.LEFT_EYE_TOP] = v(0.5, 0.3 + dx * aspect); lm[FACE_LM.LEFT_EYE_BOTTOM] = v(0.5, 0.3 + dx * aspect);
    expect(deriveFace(lm, {}, null, aspect).roll).toBeCloseTo(Math.PI / 4, 3);
  });

  it('anchors and faceBox', () => {
    const f = deriveFace(face(), {}, null, 1);
    expect(f.noseTip).toEqual({ x: 0.5, y: 0.52 });
    expect(f.chin.y).toBeCloseTo(0.75);
    expect(f.forehead.y).toBeCloseTo(0.25);
    expect(f.faceBox.x).toBeCloseTo(0.35);
    expect(f.faceBox.w).toBeCloseTo(0.3);
    expect(f.faceBox.y).toBeCloseTo(0.25);
    expect(f.faceBox.h).toBeCloseTo(0.5);
    expect(f.landmarks).toHaveLength(478);
  });

  it('uses blendshapes for mouthOpen and smile when present', () => {
    const f = deriveFace(face(), { jawOpen: 0.7, mouthSmileLeft: 0.2, mouthSmileRight: 0.6 }, null, 1);
    expect(f.mouthOpen).toBeCloseTo(0.7);
    expect(f.smile).toBeCloseTo(0.4);
  });

  it('falls back to landmark geometry without blendshapes', () => {
    const closed = deriveFace(face({ mouthGap: 0, eyeGap: 0.002 }), {}, null, 1);
    expect(closed.mouthOpen).toBeCloseTo(0, 2);
    expect(closed.eyeOpenLeft).toBeLessThan(0.1);
    const open = deriveFace(face({ mouthGap: 0.07, eyeGap: 0.035 }), {}, null, 1);
    expect(open.mouthOpen).toBeGreaterThan(0.8);
    expect(open.eyeOpenLeft).toBeGreaterThan(0.9);
    expect(open.smile).toBeGreaterThanOrEqual(0);
    expect(open.smile).toBeLessThanOrEqual(1);
  });

  it('passes the transform through', () => {
    const m = new Float32Array(16);
    expect(deriveFace(face(), {}, m, 1).transform).toBe(m);
    expect(deriveFace(face(), {}, null, 1).transform).toBeNull();
  });
});
