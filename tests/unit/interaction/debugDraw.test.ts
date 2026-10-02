import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERACTION_SETTINGS } from '../../../src/types';
import { drawLandmarks, HAND_CONNECTIONS } from '../../../src/interaction/debugDraw';
import type { DebugCanvas2D } from '../../../src/interaction/debugDraw';
import { computeWindowQuad } from '../../../src/interaction/windowQuad';
import { lPoseHands, makeFrame } from './helpers';

interface Call { name: string; args: number[] }

/** Minimal recording Canvas2D double — only the members `drawLandmarks` is allowed to touch. */
function fakeCtx(): { ctx: DebugCanvas2D; calls: Call[]; texts: string[] } {
  const calls: Call[] = [];
  const texts: string[] = [];
  const rec = (name: string) => (...args: number[]) => { calls.push({ name, args }); };
  const ctx: DebugCanvas2D = {
    save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), stroke: rec('stroke'), fill: rec('fill'),
    arc: rec('arc'),
    fillText: (text: string, x: number, y: number) => { texts.push(text); calls.push({ name: 'fillText', args: [x, y] }); },
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '',
  };
  return { ctx, calls, texts };
}

const size = { width: 1000, height: 500 };

describe('HAND_CONNECTIONS', () => {
  it('is the 21-edge MediaPipe hand skeleton with valid indices', () => {
    expect(HAND_CONNECTIONS).toHaveLength(21);
    for (const [a, b] of HAND_CONNECTIONS) {
      expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThan(21);
      expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(21);
      expect(a).not.toBe(b);
    }
  });
});

describe('drawLandmarks', () => {
  it('draws nothing but save/restore for a null frame', () => {
    const { ctx, calls } = fakeCtx();
    drawLandmarks(ctx, null, size);
    expect(calls.filter((c) => c.name !== 'save' && c.name !== 'restore')).toEqual([]);
  });

  it('draws one skeleton segment per connection per hand, in pixel space', () => {
    const { ctx, calls } = fakeCtx();
    const [l, r] = lPoseHands();
    drawLandmarks(ctx, makeFrame([l, r]), size);
    const lineTos = calls.filter((c) => c.name === 'lineTo');
    expect(lineTos.length).toBeGreaterThanOrEqual(HAND_CONNECTIONS.length * 2);
    // Index tip of the left hand appears as a pixel coordinate somewhere in the path.
    const px = l.indexTip.x * size.width;
    const py = l.indexTip.y * size.height;
    const hit = calls.some((c) => (c.name === 'lineTo' || c.name === 'moveTo' || c.name === 'arc') && Math.abs(c.args[0]! - px) < 1e-9 && Math.abs(c.args[1]! - py) < 1e-9);
    expect(hit).toBe(true);
  });

  it('marks the four window corners (index + thumb tip of each hand) with circles', () => {
    const { ctx, calls } = fakeCtx();
    const [l, r] = lPoseHands();
    drawLandmarks(ctx, makeFrame([l, r]), size);
    const arcs = calls.filter((c) => c.name === 'arc');
    const tips = [l.indexTip, l.thumbTip, r.indexTip, r.thumbTip];
    for (const tip of tips) {
      const found = arcs.some((a) => Math.abs(a.args[0]! - tip.x * size.width) < 1e-9 && Math.abs(a.args[1]! - tip.y * size.height) < 1e-9);
      expect(found).toBe(true);
    }
  });

  it('outlines the quad and prints debug state when extras are supplied', () => {
    const { ctx, calls, texts } = fakeCtx();
    const hands = lPoseHands();
    const quad = computeWindowQuad(hands, DEFAULT_INTERACTION_SETTINGS, null, 0);
    drawLandmarks(ctx, makeFrame(hands), size, { quad, debug: { armed: true, togetherMs: 420, handsUsed: 2 } });
    expect(calls.some((c) => c.name === 'closePath')).toBe(true);
    expect(texts.join(' ')).toMatch(/armed/);
    expect(texts.join(' ')).toMatch(/420/);
    expect(texts.join(' ')).toMatch(/convex/);
  });

  it('never passes non-finite numbers to the canvas', () => {
    const { ctx, calls } = fakeCtx();
    const [l, r] = lPoseHands();
    l.landmarks[12] = { x: Number.NaN, y: 0.5, z: 0 };
    l.indexTip = { x: Number.POSITIVE_INFINITY, y: 0.3 };
    drawLandmarks(ctx, makeFrame([l, r]), size);
    for (const c of calls) for (const a of c.args) expect(Number.isFinite(a)).toBe(true);
  });

  it('handles a zero-sized canvas without throwing', () => {
    const { ctx } = fakeCtx();
    expect(() => drawLandmarks(ctx, makeFrame(lPoseHands()), { width: 0, height: 0 })).not.toThrow();
  });
});
