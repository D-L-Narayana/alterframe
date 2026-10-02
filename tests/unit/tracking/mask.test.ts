import { describe, expect, it } from 'vitest';
import { resampleMask, MASK_SIZE, maskOrientationFlipY } from '../../../src/tracking/mask';

/** 4×2 source: row 0 = [0,1,2,3], row 1 = [4,5,6,7]. */
const src = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);

describe('resampleMask', () => {
  it('copies 1:1 when sizes match and no flips', () => {
    const dst = new Float32Array(8);
    resampleMask(src, 4, 2, dst, 4, 2, { mirror: false, flipY: false });
    expect(Array.from(dst)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('mirror flips columns', () => {
    const dst = new Float32Array(8);
    resampleMask(src, 4, 2, dst, 4, 2, { mirror: true, flipY: false });
    expect(Array.from(dst)).toEqual([3, 2, 1, 0, 7, 6, 5, 4]);
  });

  it('flipY flips rows (GPU bottom-left origin → top-left)', () => {
    const dst = new Float32Array(8);
    resampleMask(src, 4, 2, dst, 4, 2, { mirror: false, flipY: true });
    expect(Array.from(dst)).toEqual([4, 5, 6, 7, 0, 1, 2, 3]);
  });

  it('both flips = 180° rotation', () => {
    const dst = new Float32Array(8);
    resampleMask(src, 4, 2, dst, 4, 2, { mirror: true, flipY: true });
    expect(Array.from(dst)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('downsamples with nearest-neighbour (pixel-centre sampling)', () => {
    // 4×2 → 2×1: centres at x=0.25,0.75 of width → source columns 1 and 3; y centre 0.5 → row 1
    const dst = new Float32Array(2);
    resampleMask(src, 4, 2, dst, 2, 1, { mirror: false, flipY: false });
    expect(Array.from(dst)).toEqual([5, 7]);
  });

  it('upsamples by repeating source samples', () => {
    const s = new Float32Array([0, 1]); // 2×1
    const dst = new Float32Array(4);
    resampleMask(s, 2, 1, dst, 4, 1, { mirror: false, flipY: false });
    expect(Array.from(dst)).toEqual([0, 0, 1, 1]);
  });

  it('accepts Uint8Array sources and normalises to 0..1', () => {
    const s = new Uint8Array([0, 255, 128, 0]);
    const dst = new Float32Array(4);
    resampleMask(s, 2, 2, dst, 2, 2, { mirror: false, flipY: false });
    expect(dst[1]).toBeCloseTo(1);
    expect(dst[2]).toBeCloseTo(128 / 255, 3);
  });

  it('default output size is 256×256', () => {
    expect(MASK_SIZE).toBe(256);
  });
});

describe('maskOrientationFlipY', () => {
  it('auto never flips: measured top-left origin for both CPU and GPU read-back (tasks-vision 1.0.1)', () => {
    expect(maskOrientationFlipY('auto', true)).toBe(false);
    expect(maskOrientationFlipY('auto', false)).toBe(false);
  });
  it('explicit policies override detection', () => {
    expect(maskOrientationFlipY('always', false)).toBe(true);
    expect(maskOrientationFlipY('never', true)).toBe(false);
  });
});
