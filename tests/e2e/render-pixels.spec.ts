/**
 * Compositor pixel proof (owner: W10, verifies W4 via readPixels — contract §W4 acceptance):
 * with a solid base and a solid window style, pixels inside the quad equal the window colour,
 * outside equal the base colour, and opacity 0.5 yields a blend. Also asserts the single cover-fit
 * mapping at three viewports and that mirroring flips the video sampling only, not the quad.
 */
import { test, expect, type Page } from '@playwright/test';
import type { QuadCorners } from '@/types';
import { stagePixels, regionMean, coverRect } from './helpers/app';

/**
 * Visible part of display space under cover-fit: when the canvas is narrower than the video the
 * sides are cropped (e.g. 390×844 shows display x ≈ 0.37–0.63; 1024² shows ≈ 0.22–0.78), when it
 * is wider the top/bottom are cropped. All probes and the quad itself are placed RELATIVE to this
 * rect so every viewport tests the same coverage (inside / outside / edge) on genuinely visible pixels.
 */
function visibleDisplayRect(cssW: number, cssH: number, srcW = 640, srcH = 360) {
  const canvasAspect = cssW / cssH;
  const videoAspect = srcW / srcH;
  if (canvasAspect >= videoAspect) {
    const visH = videoAspect / canvasAspect; // fraction of display height visible
    return { x0: 0, x1: 1, y0: (1 - visH) / 2, y1: (1 - visH) / 2 + visH };
  }
  const visW = canvasAspect / videoAspect;
  return { x0: (1 - visW) / 2, x1: (1 - visW) / 2 + visW, y0: 0, y1: 1 };
}
type NRect = { x0: number; y0: number; x1: number; y1: number };
/** Map a rect given in visible-relative units (0..1 inside the visible rect) to display space. */
function rel(vis: NRect, r: NRect): NRect {
  const w = vis.x1 - vis.x0;
  const h = vis.y1 - vis.y0;
  return { x0: vis.x0 + r.x0 * w, y0: vis.y0 + r.y0 * h, x1: vis.x0 + r.x1 * w, y1: vis.y0 + r.y1 * h };
}
/** Axis-aligned quad covering visible-relative x 0.2..0.6, y 0.3..0.7. */
function quadFor(vis: NRect): QuadCorners {
  const r = rel(vis, { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.7 });
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
}
const FULL: NRect = { x0: 0, y0: 0, x1: 1, y1: 1 };
const QUAD: QuadCorners = quadFor(FULL); // used by the single-viewport tests (1280×720 ≈ 16:9 → fully visible)

async function openHarness(page: Page) {
  await page.goto('/tests/e2e/pages/pixels.html');
  await page.waitForFunction(() => window.__pixels?.ready === true, undefined, { timeout: 60_000 });
  const err = await page.evaluate(() => window.__pixels?.error);
  expect(err, 'renderer harness error (W4 createRenderer missing or init failed)').toBeUndefined();
}

/** Normalized display rect → fraction rect of the canvas, through cover-fit (video 640×360). */
function frac(rect: NRect, css: { cssWidth: number; cssHeight: number }): NRect {
  const r = coverRect({ x: 0, y: 0, width: css.cssWidth, height: css.cssHeight }, 640, 360);
  const f = (nx: number, ny: number) => ({ x: (r.x + nx * r.w) / css.cssWidth, y: (r.y + ny * r.h) / css.cssHeight });
  const a = f(rect.x0, rect.y0);
  const b = f(rect.x1, rect.y1);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

const near = (v: number, target: number, tol = 24) => Math.abs(v - target) <= tol;

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
  { width: 1024, height: 1024 },
]) {
  test(`solid base/window → correct colours inside/outside the quad @ ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openHarness(page);
    const vis = visibleDisplayRect(viewport.width, viewport.height);
    const quad = quadFor(vis);
    const info = await page.evaluate((q) => window.__pixels!.render({ corners: q, base: [1, 0, 0], window: [0, 1, 0] }), quad);
    const px = await stagePixels(page, 256);
    // Sanity: every probe below lies inside the visible rect, so regionMean averages real pixels.
    const probe = (r: NRect) => {
      const d = rel(vis, r);
      expect(d.x0).toBeGreaterThanOrEqual(vis.x0 - 1e-9);
      expect(d.x1).toBeLessThanOrEqual(vis.x1 + 1e-9);
      return frac(d, info);
    };

    // Inside (shrunk by 0.04 of the visible width to stay clear of edges).
    const [ir, ig, ib] = regionMean(px, probe({ x0: 0.24, y0: 0.34, x1: 0.56, y1: 0.66 }));
    expect(near(ir, 0) && near(ig, 255) && near(ib, 0), `inside quad is window colour (got ${[ir, ig, ib].map(Math.round)})`).toBe(true);

    // Outside: a strip right of the quad, still inside the visible rect.
    const [or, og, ob] = regionMean(px, probe({ x0: 0.66, y0: 0.34, x1: 0.95, y1: 0.66 }));
    expect(near(or, 255) && near(og, 0) && near(ob, 0), `outside quad is base colour (got ${[or, og, ob].map(Math.round)})`).toBe(true);

    // Edge position (single cover-fit mapping): left edge at visible-relative x=0.2 → ±2–3.5 % either side.
    const leftIn = regionMean(px, probe({ x0: 0.205, y0: 0.4, x1: 0.235, y1: 0.6 }));
    const leftOut = regionMean(px, probe({ x0: 0.165, y0: 0.4, x1: 0.195, y1: 0.6 }));
    expect(leftIn[1], 'just inside the left edge is green').toBeGreaterThan(200);
    expect(leftOut[0], 'just outside the left edge is red').toBeGreaterThan(200);
    // Top edge likewise (y = 0.3 visible-relative).
    const topIn = regionMean(px, probe({ x0: 0.3, y0: 0.305, x1: 0.5, y1: 0.335 }));
    const topOut = regionMean(px, probe({ x0: 0.3, y0: 0.265, x1: 0.5, y1: 0.295 }));
    expect(topIn[1], 'just inside the top edge is green').toBeGreaterThan(200);
    expect(topOut[0], 'just outside the top edge is red').toBeGreaterThan(200);
  });
}

test('quad opacity 0.5 blends base and window colours', async ({ page }) => {
  await openHarness(page);
  const info = await page.evaluate((q) => window.__pixels!.render({ corners: q, opacity: 0.5, base: [1, 0, 0], window: [0, 1, 0] }), QUAD);
  const px = await stagePixels(page, 256);
  const [r, g, b] = regionMean(px, frac({ x0: 0.24, y0: 0.34, x1: 0.56, y1: 0.66 }, info));
  // Linear mix(red, green, 0.5) = (0.5, 0.5, 0) → ~128,128,0 (allow sRGB/8-bit slack).
  expect(r, 'red component blended').toBeGreaterThan(80);
  expect(r).toBeLessThan(200);
  expect(g, 'green component blended').toBeGreaterThan(80);
  expect(g).toBeLessThan(200);
  expect(b).toBeLessThan(30);
});

test('no quad → whole frame is the base colour', async ({ page }) => {
  await openHarness(page);
  const info = await page.evaluate(() => window.__pixels!.render({ corners: null, base: [1, 0, 0], window: [0, 1, 0] }));
  const px = await stagePixels(page, 128);
  const [r, g] = regionMean(px, frac({ x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.95 }, info));
  expect(r).toBeGreaterThan(230);
  expect(g).toBeLessThan(25);
});

test('mirrored flag flips the VIDEO sampling only, not the quad (quad is already in display space)', async ({ page }) => {
  await openHarness(page);
  const info = await page.evaluate((q) => window.__pixels!.render({ corners: q, mirrored: true, base: [1, 0, 0], window: [0, 1, 0] }), QUAD);
  const px = await stagePixels(page, 256);
  const [, g] = regionMean(px, frac({ x0: 0.24, y0: 0.34, x1: 0.56, y1: 0.66 }, info));
  expect(g, 'window still at x 0.2..0.6 when mirrored').toBeGreaterThan(200);
  const [r2] = regionMean(px, frac({ x0: 0.66, y0: 0.34, x1: 0.95, y1: 0.66 }, info));
  expect(r2, 'the mirrored region (x 0.4..0.8 → sampled) stays base colour').toBeGreaterThan(200);
});
