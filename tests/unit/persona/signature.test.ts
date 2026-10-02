import { describe, it, expect } from 'vitest';
import { overlaySignature, backdropSignature, quantize } from '../../../src/render/persona/signature';
import { makeFace, makeFrame, SIZE } from './fixtures';
import type { SceneState } from '../../../src/types';

const scene = (persona: SceneState['persona']): SceneState => ({ base: 'live', persona, hudTint: 'white' });

describe('quantize', () => {
  it('rounds to the given step so sub-pixel jitter does not count as a change', () => {
    expect(quantize(0.50001, 0.001)).toBe(quantize(0.50049, 0.001));
    expect(quantize(0.5, 0.001)).not.toBe(quantize(0.502, 0.001));
  });
});

describe('overlaySignature', () => {
  it('is identical for identical inputs and changes when the face moves', () => {
    const a = overlaySignature(makeFrame(makeFace()), scene('portrait'), SIZE, 0);
    const b = overlaySignature(makeFrame(makeFace()), scene('portrait'), SIZE, 0);
    const c = overlaySignature(makeFrame(makeFace({ cx: 0.52 })), scene('portrait'), SIZE, 0);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it('changes with persona, canvas size, roll, blink and mouth state', () => {
    const base = overlaySignature(makeFrame(makeFace()), scene('portrait'), SIZE, 0);
    expect(overlaySignature(makeFrame(makeFace()), scene('masked'), SIZE, 0)).not.toBe(base);
    expect(overlaySignature(makeFrame(makeFace()), scene('portrait'), { width: 800, height: 400 }, 0)).not.toBe(base);
    expect(overlaySignature(makeFrame(makeFace({ roll: 0.3 })), scene('portrait'), SIZE, 0)).not.toBe(base);
    expect(overlaySignature(makeFrame(makeFace({ eyeOpen: 0.2 })), scene('portrait'), SIZE, 0)).not.toBe(base);
    expect(overlaySignature(makeFrame(makeFace({ mouthOpen: 0.6 })), scene('portrait'), SIZE, 0)).not.toBe(base);
  });
  it('a face-less frame has a stable signature per persona and differs from any face', () => {
    const none1 = overlaySignature(makeFrame(null), scene('suit'), SIZE, 0);
    const none2 = overlaySignature(makeFrame(null), scene('suit'), SIZE, 5000);
    expect(none1).toBe(none2);
    expect(none1).not.toBe(overlaySignature(makeFrame(makeFace()), scene('suit'), SIZE, 0));
  });
  it('ignores time for static personas (portrait, masked, suit overlays do not animate on their own)', () => {
    const a = overlaySignature(makeFrame(makeFace()), scene('masked'), SIZE, 0);
    const b = overlaySignature(makeFrame(makeFace()), scene('masked'), SIZE, 1234);
    expect(a).toBe(b);
  });
});

describe('backdropSignature', () => {
  it('portrait and suit backdrops depend only on persona and size', () => {
    for (const p of ['portrait', 'suit'] as const) {
      const a = backdropSignature(scene(p), SIZE, 0, false);
      const b = backdropSignature(scene(p), SIZE, 9999, false);
      expect(a).toBe(b);
      expect(backdropSignature(scene(p), { width: 10, height: 10 }, 0, false)).not.toBe(a);
    }
  });
  it('masked backdrop animates with time (bucketed to ~30 Hz) unless reduced motion is on', () => {
    const a = backdropSignature(scene('masked'), SIZE, 0, false);
    expect(backdropSignature(scene('masked'), SIZE, 10, false)).toBe(a); // same 33 ms bucket
    expect(backdropSignature(scene('masked'), SIZE, 500, false)).not.toBe(a);
    const r0 = backdropSignature(scene('masked'), SIZE, 0, true);
    const r1 = backdropSignature(scene('masked'), SIZE, 500, true);
    expect(r0).toBe(r1);
  });
});
