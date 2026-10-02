import { describe, it, expect } from 'vitest';
import { drawDebugLandmarks, HAND_CONNECTIONS } from '../../../src/hud/debugDraw';
import { createFakeContext, ops } from './fakeContext';
import { makeFace, makeFrame } from './fixtures';
import type { HandTrack, Vec3 } from '../../../src/types';

const SIZE = { width: 1000, height: 500 };

function makeHand(side: 'left' | 'right', x0: number): HandTrack {
  const landmarks: Vec3[] = Array.from({ length: 21 }, (_, i) => ({ x: x0 + i * 0.005, y: 0.5 + i * 0.01, z: 0 }));
  return { side, landmarks, score: 0.9, indexTip: landmarks[8]!, thumbTip: landmarks[4]!, palmCenter: landmarks[9]!, size: 0.1 };
}

describe('drawDebugLandmarks', () => {
  it('draws one dot per hand landmark plus the skeleton', () => {
    const { ctx, calls } = createFakeContext();
    drawDebugLandmarks(ctx, makeFrame({ hands: [makeHand('left', 0.1), makeHand('right', 0.6)] }), SIZE);
    expect(ops(calls, 'arc').length).toBeGreaterThanOrEqual(42);
    expect(ops(calls, 'lineTo').length).toBeGreaterThanOrEqual(HAND_CONNECTIONS.length * 2);
    expect(HAND_CONNECTIONS.length).toBe(21);
  });

  it('highlights the two window corners (index + thumb tips) with larger dots', () => {
    const { ctx, calls } = createFakeContext();
    const hand = makeHand('left', 0.1);
    drawDebugLandmarks(ctx, makeFrame({ hands: [hand] }), SIZE);
    const arcs = ops(calls, 'arc').map((a) => a.args.map(Number));
    const radii = new Set(arcs.map((a) => a[2]));
    expect(radii.size).toBe(2);
    const big = Math.max(...Array.from(radii).map((r) => r ?? 0));
    const bigArcs = arcs.filter((a) => a[2] === big);
    expect(bigArcs).toHaveLength(2);
    expect(bigArcs.some((a) => Math.abs(a[0]! - hand.indexTip.x * 1000) < 1e-6)).toBe(true);
    expect(bigArcs.some((a) => Math.abs(a[0]! - hand.thumbTip.x * 1000) < 1e-6)).toBe(true);
  });

  it('draws the face box and eye anchors when a face is present', () => {
    const { ctx, calls } = createFakeContext();
    const face = makeFace();
    drawDebugLandmarks(ctx, makeFrame({ face }), SIZE);
    const rect = ops(calls, 'strokeRect')[0]!;
    expect(rect.args.map(Number)).toEqual([400, 150, 200, 180]);
    const arcs = ops(calls, 'arc').map((a) => a.args.map(Number));
    expect(arcs.some((a) => a[0] === 450 && a[1] === 200)).toBe(true); // leftEye
    expect(arcs.some((a) => a[0] === 550 && a[1] === 200)).toBe(true); // rightEye
  });

  it('draws nothing for an empty frame', () => {
    const { ctx, calls } = createFakeContext();
    drawDebugLandmarks(ctx, makeFrame(), SIZE);
    expect(calls.filter((c) => !['save', 'restore'].includes(c.op))).toEqual([]);
  });
});
