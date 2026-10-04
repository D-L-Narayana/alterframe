import { describe, it, expect } from 'vitest';
import {
  coverFit,
  containFit,
  fitFor,
  fitContentRect,
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

describe('containFit (letterbox: whole frame visible, bars outside display uv [0,1])', () => {
  it('is identity when aspects match', () => {
    const f = containFit(1280, 720, 1920, 1080);
    expect(f.uvScale[0]).toBeCloseTo(1, 6);
    expect(f.uvScale[1]).toBeCloseTo(1, 6);
    expect(f.uvOffset[0]).toBeCloseTo(0, 6);
    expect(f.uvOffset[1]).toBeCloseTo(0, 6);
    expect(f.visible).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(fitContentRect(f)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('16:9 video into a 1:1 canvas: full width, bars top and bottom, content centred', () => {
    const f = containFit(1280, 720, 1000, 1000);
    // Letterboxed axis: uvScale > 1 and a negative offset, so canvas rows in the bars map outside [0,1].
    expect(f.uvScale[0]).toBeCloseTo(1, 6);
    expect(f.uvScale[1]).toBeCloseTo(16 / 9, 6);
    expect(f.uvOffset[0]).toBeCloseTo(0, 6);
    expect(f.uvOffset[1]).toBeCloseTo((1 - 16 / 9) / 2, 6);
    expect(f.uvOffset[1]).toBeLessThan(0);
    // The whole display frame is visible.
    expect(f.visible).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    // Content occupies a centred band 9/16 of the canvas height.
    const rect = fitContentRect(f);
    expect(rect.x).toBeCloseTo(0, 6);
    expect(rect.w).toBeCloseTo(1, 6);
    expect(rect.h).toBeCloseTo(9 / 16, 6);
    expect(rect.y).toBeCloseTo((1 - 9 / 16) / 2, 6);
    expect(rect.y + rect.h / 2).toBeCloseTo(0.5, 6); // centred
    // canvas centre maps to display centre
    expect(0.5 * f.uvScale[0] + f.uvOffset[0]).toBeCloseTo(0.5, 6);
    expect(0.5 * f.uvScale[1] + f.uvOffset[1]).toBeCloseTo(0.5, 6);
  });

  it('16:9 video into a 9:16 canvas: deeper bars, content still centred', () => {
    const f = containFit(1280, 720, 1080, 1920);
    const canvasAspect = 1080 / 1920;
    const videoAspect = 1280 / 720;
    expect(f.uvScale[0]).toBeCloseTo(1, 6);
    expect(f.uvScale[1]).toBeCloseTo(videoAspect / canvasAspect, 6);
    expect(f.uvOffset[1]).toBeCloseTo((1 - videoAspect / canvasAspect) / 2, 6);
    const rect = fitContentRect(f);
    expect(rect.h).toBeCloseTo(canvasAspect / videoAspect, 6); // 0.3164 of the canvas height
    expect(rect.y).toBeCloseTo((1 - canvasAspect / videoAspect) / 2, 6);
    expect(rect.y + rect.h / 2).toBeCloseTo(0.5, 6);
    // Bars: the top 34 % and bottom 34 % of the canvas.
    expect(rect.y).toBeGreaterThan(0.34);
    expect(rect.y + rect.h).toBeLessThan(0.66);
  });

  it('4:3 video into a 16:9 canvas: pillarbox (bars left and right)', () => {
    const f = containFit(640, 480, 1920, 1080);
    expect(f.uvScale[1]).toBeCloseTo(1, 6);
    expect(f.uvScale[0]).toBeCloseTo((1920 / 1080) / (640 / 480), 6);
    expect(f.uvOffset[0]).toBeCloseTo((1 - f.uvScale[0]) / 2, 6);
    expect(f.uvOffset[0]).toBeLessThan(0);
    expect(f.uvOffset[1]).toBeCloseTo(0, 6);
    const rect = fitContentRect(f);
    expect(rect.w).toBeCloseTo(0.75, 6);
    expect(rect.x).toBeCloseTo(0.125, 6);
    expect(rect.y).toBeCloseTo(0, 6);
    expect(rect.h).toBeCloseTo(1, 6);
  });

  it('canvas pixels inside the bars map to display uv outside [0,1]; content pixels map inside', () => {
    const f = containFit(1280, 720, 1000, 1000);
    const top = canvasPxToDisplay({ x: 500, y: 100 }, 1000, 1000, f);
    const bottom = canvasPxToDisplay({ x: 500, y: 900 }, 1000, 1000, f);
    const centre = canvasPxToDisplay({ x: 500, y: 500 }, 1000, 1000, f);
    const firstContentRow = canvasPxToDisplay({ x: 500, y: 220 }, 1000, 1000, f);
    expect(top.y).toBeLessThan(0);
    expect(bottom.y).toBeGreaterThan(1);
    expect(centre.x).toBeCloseTo(0.5, 6);
    expect(centre.y).toBeCloseTo(0.5, 6);
    expect(firstContentRow.y).toBeGreaterThanOrEqual(0);
    expect(firstContentRow.y).toBeLessThan(0.01);
  });

  it('display corners land on the content rect edges and round-trip exactly', () => {
    const f = containFit(1280, 720, 1000, 1000);
    const tl = displayToCanvasPx({ x: 0, y: 0 }, 1000, 1000, f);
    const br = displayToCanvasPx({ x: 1, y: 1 }, 1000, 1000, f);
    expect(tl.x).toBeCloseTo(0, 6);
    expect(tl.y).toBeCloseTo(218.75, 6);
    expect(br.x).toBeCloseTo(1000, 6);
    expect(br.y).toBeCloseTo(781.25, 6);
    for (const p of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.25, y: 0.75 }, { x: 0.5, y: 0.5 }]) {
      const back = canvasPxToDisplay(displayToCanvasPx(p, 1000, 1000, f), 1000, 1000, f);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
    // Same round trip at a 2× backing store (360×640 for 180×320 css).
    const portrait = containFit(640, 360, 360, 640);
    const px = displayToCanvasPx({ x: 0.75, y: 0.7 }, 360, 640, portrait);
    expect(px.x).toBeCloseTo(270, 6);
    // content band: 360 × (9/16) = 202.5 px tall, starting at (640 − 202.5) / 2 = 218.75
    expect(px.y).toBeCloseTo(218.75 + 0.7 * 202.5, 6);
    const back = canvasPxToDisplay(px, 360, 640, portrait);
    expect(back.x).toBeCloseTo(0.75, 9);
    expect(back.y).toBeCloseTo(0.7, 9);
  });

  it('tolerates degenerate sizes (identity, no NaN)', () => {
    for (const f of [containFit(0, 0, 100, 100), containFit(100, 100, 0, 0), containFit(Number.NaN, 1, 1, 1), containFit(-5, 10, 10, 10)]) {
      expect(f.uvScale).toEqual([1, 1]);
      expect(f.uvOffset).toEqual([0, 0]);
      expect(f.visible).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    }
  });

  it('is the inverse crop of coverFit: content rect of contain == 1 / visible rect of cover', () => {
    const cover = coverFit(1280, 720, 1000, 1000);
    const contain = containFit(1280, 720, 1000, 1000);
    // Cover shows 0.5625 of the display width; contain shows the display in 0.5625 of the canvas height.
    expect(cover.visible.w).toBeCloseTo(fitContentRect(contain).h, 6);
    expect(fitContentRect(cover).w).toBeCloseTo(1 / 0.5625, 6); // cover content rect spills outside the canvas
    expect(fitContentRect(cover).x).toBeLessThan(0);
  });
});

describe('fitFor (mode dispatch)', () => {
  const sizes: [number, number, number, number][] = [
    [1280, 720, 1920, 1080],
    [1280, 720, 1080, 1920],
    [640, 480, 1920, 1080],
    [640, 360, 360, 360],
    [640, 360, 360, 640],
    [640, 360, 640, 200],
    [0, 0, 100, 100],
  ];

  it("'cover' returns exactly what coverFit returns (default path unchanged)", () => {
    for (const s of sizes) expect(fitFor('cover', ...s)).toEqual(coverFit(...s));
  });

  it("'contain' returns exactly what containFit returns", () => {
    for (const s of sizes) expect(fitFor('contain', ...s)).toEqual(containFit(...s));
  });

  it('cover and contain agree only when the aspects match', () => {
    expect(fitFor('cover', 1280, 720, 1920, 1080)).toEqual(fitFor('contain', 1280, 720, 1920, 1080));
    expect(fitFor('cover', 1280, 720, 1000, 1000)).not.toEqual(fitFor('contain', 1280, 720, 1000, 1000));
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

  it('accepts either fit: the same display point lands at different pixels under cover and contain', () => {
    const cover = fitFor('cover', 640, 360, 360, 360);
    const contain = fitFor('contain', 640, 360, 360, 360);
    const p = { x: 0.1, y: 0.25 };
    const a = displayToCanvasPx(p, 360, 360, cover);
    const b = displayToCanvasPx(p, 360, 360, contain);
    // cover: display x 0.1 is cropped away (left of the canvas: visible x is 0.219..0.781); contain: it is at a tenth of the width
    expect(a.x).toBeLessThan(0);
    expect(b.x).toBeCloseTo(36, 6);
    expect(a.y).toBeCloseTo(90, 6);
    expect(b.y).toBeCloseTo(78.75 + 0.25 * 202.5, 6);
    expect(canvasPxToDisplay(b, 360, 360, contain).x).toBeCloseTo(0.1, 9);
    expect(canvasPxToDisplay(b, 360, 360, contain).y).toBeCloseTo(0.25, 9);
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
