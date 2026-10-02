import { describe, it, expect } from 'vitest';
import { computeCrop, OUTPUT_SIZES } from '@/capture/crop';
import type { CaptureAspect } from '@/types/capture';

describe('computeCrop', () => {
  it('source aspect keeps the whole canvas, forced to even dimensions', () => {
    const c = computeCrop(1281, 719, 'source');
    expect(c).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 718, dw: 1280, dh: 718 });
  });

  it('9:16 from a 16:9 source crops the centre column to 1080×1920', () => {
    const c = computeCrop(1920, 1080, '9:16');
    expect(c.dw).toBe(1080);
    expect(c.dh).toBe(1920);
    // source region keeps full height, width = 1080 * 9/16 = 607.5 → even 608
    expect(c.sh).toBe(1080);
    expect(c.sw).toBe(608);
    expect(c.sy).toBe(0);
    // centred horizontally
    expect(c.sx).toBe(Math.round((1920 - 608) / 2));
  });

  it('16:9 from a portrait source crops the centre band to 1920×1080', () => {
    const c = computeCrop(1080, 1920, '16:9');
    expect(c.dw).toBe(1920);
    expect(c.dh).toBe(1080);
    expect(c.sw).toBe(1080);
    expect(c.sh).toBe(608); // 1080 * 9/16 = 607.5 → even
    expect(c.sx).toBe(0);
    expect(c.sy).toBe(Math.round((1920 - 608) / 2));
  });

  it('1:1 from a landscape source crops a centred square to 1080×1080', () => {
    const c = computeCrop(1280, 720, '1:1');
    expect(c).toEqual({ sx: 280, sy: 0, sw: 720, sh: 720, dw: 1080, dh: 1080 });
  });

  it('matching aspect uses the full source', () => {
    const c = computeCrop(1920, 1080, '16:9');
    expect(c).toMatchObject({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
  });

  it('always yields even, positive dimensions for every aspect and odd sources', () => {
    const aspects: CaptureAspect[] = ['source', '16:9', '9:16', '1:1'];
    for (const a of aspects) {
      for (const [w, h] of [[641, 361], [333, 1001], [7, 5], [1919, 1079]] as const) {
        const c = computeCrop(w, h, a);
        for (const v of [c.sw, c.sh, c.dw, c.dh]) {
          expect(v).toBeGreaterThan(0);
          expect(v % 2).toBe(0);
        }
        expect(c.sx).toBeGreaterThanOrEqual(0);
        expect(c.sy).toBeGreaterThanOrEqual(0);
        expect(c.sx + c.sw).toBeLessThanOrEqual(w);
        expect(c.sy + c.sh).toBeLessThanOrEqual(h);
      }
    }
  });

  it('source region aspect matches the output aspect within one pixel of rounding', () => {
    for (const a of ['16:9', '9:16', '1:1'] as const) {
      const out = OUTPUT_SIZES[a];
      const c = computeCrop(1366, 768, a);
      const target = out.width / out.height;
      expect(Math.abs(c.sw / c.sh - target) * c.sh).toBeLessThanOrEqual(2);
    }
  });

  it('throws a readable error for an empty source', () => {
    expect(() => computeCrop(0, 720, '1:1')).toThrow(/empty|zero/i);
  });
});
