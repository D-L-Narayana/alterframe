import { describe, it, expect } from 'vitest';
import {
  coverFit,
  backingSize,
  internalSize,
  displayToClip,
  quadToClipTriangles,
  displayToCanvasPx,
  canvasPxToDisplay,
  TEXTURE_UNITS,
  TEXTURE_UNIT_ORDER,
} from '../../../src/render/core/fit';
import type { QuadCorners } from '../../../src/types';

describe('coverFit (display uv <- canvas uv mapping)', () => {
  it('is identity when aspects match', () => {
    const f = coverFit(1280, 720, 1920, 1080);
    expect(f.uvScale[0]).toBeCloseTo(1, 6);
    expect(f.uvScale[1]).toBeCloseTo(1, 6);
    expect(f.uvOffset[0]).toBeCloseTo(0, 6);
    expect(f.uvOffset[1]).toBeCloseTo(0, 6);
    expect(f.visible).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('crops left/right when the canvas is taller than the source (portrait phone over 16:9 video)', () => {
    const f = coverFit(1280, 720, 1080, 1920);
    // source aspect 1.777, dst aspect 0.5625 -> keep full height, show a 0.5625/1.777 = 0.316 wide slice centred
    expect(f.uvScale[1]).toBeCloseTo(1, 6);
    expect(f.uvScale[0]).toBeCloseTo((1080 / 1920) / (1280 / 720), 6);
    expect(f.uvOffset[0]).toBeCloseTo((1 - f.uvScale[0]) / 2, 6);
    expect(f.uvOffset[1]).toBeCloseTo(0, 6);
    // canvas centre maps to display centre
    expect(0.5 * f.uvScale[0] + f.uvOffset[0]).toBeCloseTo(0.5, 6);
  });

  it('crops top/bottom when the canvas is wider than the source', () => {
    const f = coverFit(640, 480, 1920, 1080);
    expect(f.uvScale[0]).toBeCloseTo(1, 6);
    expect(f.uvScale[1]).toBeCloseTo((640 / 480) / (1920 / 1080), 6);
    expect(f.uvOffset[1]).toBeCloseTo((1 - f.uvScale[1]) / 2, 6);
  });

  it('tolerates degenerate sizes', () => {
    const f = coverFit(0, 0, 100, 100);
    expect(f.uvScale).toEqual([1, 1]);
    expect(f.uvOffset).toEqual([0, 0]);
  });
});

describe('backingSize / internalSize', () => {
  it('backing store is the CSS box times the honoured dpr', () => {
    expect(backingSize(400, 300, 2, 2)).toEqual({ width: 800, height: 600 });
    expect(backingSize(400, 300, 3, 2)).toEqual({ width: 800, height: 600 });
    expect(backingSize(0, 0, 1, 2)).toEqual({ width: 1, height: 1 });
  });

  it('internal size follows the video aspect, renderScale and the long-side cap', () => {
    expect(internalSize(1280, 720, 1)).toEqual({ width: 1280, height: 720 });
    expect(internalSize(1280, 720, 0.5)).toEqual({ width: 640, height: 360 });
    const capped = internalSize(3840, 2160, 1, 1920);
    expect(capped).toEqual({ width: 1920, height: 1080 });
    expect(internalSize(0, 0, 1)).toEqual({ width: 2, height: 2 });
    const odd = internalSize(1281, 721, 1);
    expect(odd.width % 2).toBe(0);
    expect(odd.height % 2).toBe(0);
  });
});

describe('displayToClip / quad triangulation', () => {
  it('maps display (0,0) top-left to clip (-1,-1) under the texel-row-0-is-top convention', () => {
    // Intermediate FBOs keep texel row 0 == display top, so display y grows with clip y.
    expect(displayToClip({ x: 0, y: 0 })).toEqual([-1, -1]);
    expect(displayToClip({ x: 1, y: 1 })).toEqual([1, 1]);
    expect(displayToClip({ x: 0.5, y: 0.25 })).toEqual([0, -0.5]);
  });

  it('triangulates TL,TR,BR,BL into (TL,TR,BR) + (TL,BR,BL) with interleaved clip xy + display uv', () => {
    const corners: QuadCorners = [
      { x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }, { x: 0.9, y: 0.8 }, { x: 0.1, y: 0.8 },
    ];
    const v = quadToClipTriangles(corners);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(6 * 4);
    // vertex 0 = TL
    expect(v[0]).toBeCloseTo(-0.8); expect(v[1]).toBeCloseTo(-0.6); expect(v[2]).toBeCloseTo(0.1); expect(v[3]).toBeCloseTo(0.2);
    // vertex 2 = BR, vertex 3 = TL (second tri), vertex 4 = BR, vertex 5 = BL
    expect([v[8], v[9]]).toEqual([v[16], v[17]]);
    expect([v[12], v[13]]).toEqual([v[0], v[1]]);
    expect(v[22]).toBeCloseTo(0.1); expect(v[23]).toBeCloseTo(0.8);
  });

  it('accepts a bow-tie (faithful ordering) without throwing', () => {
    const crossed: QuadCorners = [
      { x: 0.1, y: 0.2 }, { x: 0.9, y: 0.8 }, { x: 0.9, y: 0.2 }, { x: 0.1, y: 0.8 },
    ];
    expect(() => quadToClipTriangles(crossed)).not.toThrow();
  });
});

describe('display <-> canvas pixel helpers', () => {
  it('round-trips through the cover-fit mapping', () => {
    const fit = coverFit(1280, 720, 1080, 1920);
    const px = displayToCanvasPx({ x: 0.5, y: 0.5 }, 1080, 1920, fit);
    expect(px.x).toBeCloseTo(540, 4);
    expect(px.y).toBeCloseTo(960, 4);
    const back = canvasPxToDisplay(px, 1080, 1920, fit);
    expect(back.x).toBeCloseTo(0.5, 6);
    expect(back.y).toBeCloseTo(0.5, 6);
  });

  it('is identity when aspects match', () => {
    const fit = coverFit(1280, 720, 1280, 720);
    expect(displayToCanvasPx({ x: 0.25, y: 0.75 }, 1280, 720, fit)).toEqual({ x: 320, y: 540 });
  });
});

describe('texture unit ordering', () => {
  it('reserves 0..3 for the contract samplers in prelude order', () => {
    expect(TEXTURE_UNITS.u_color).toBe(0);
    expect(TEXTURE_UNITS.u_video).toBe(1);
    expect(TEXTURE_UNITS.u_mask).toBe(2);
    expect(TEXTURE_UNITS.u_backdrop).toBe(3);
    expect(TEXTURE_UNIT_ORDER.slice(0, 4)).toEqual(['u_color', 'u_video', 'u_mask', 'u_backdrop']);
  });

  it('assigns unique units to every sampler', () => {
    const values = Object.values(TEXTURE_UNITS);
    expect(new Set(values).size).toBe(values.length);
    expect(Math.max(...values)).toBeLessThan(8); // WebGL2 guarantees >= 16; stay well within
  });
});
