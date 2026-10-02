/**
 * Window behaviour with MOCK tracking (owner: W10). Uses the dev-only `injectTracking` hook:
 *  - quad visible when two hands, hidden when none (pixel diff inside/outside the expected quad)
 *  - persona cycles exactly once after together → open (our optional gesture, contract §W7.2)
 *  - left-side mock hand lands on screen-left (mirroring applied exactly once, lead-checklist B2)
 */
import { test, expect } from '@playwright/test';
import { captureConsole, startMockSession, stagePixels, regionDiff, waitFrames, canvasBox, coverRect } from './helpers/app';
import { holdSample, holdSequence, stopMock, POSES, type MockSample } from './helpers/mockTracking';

/** Normalized bbox of a sample's quad (index/thumb tips of both hands), padded inward by `inset`. */
function quadBBox(sample: MockSample, inset = 0.02) {
  const pts = sample.hands.flatMap((h) => [h.indexTip, h.thumbTip]);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs) + inset, y0: Math.min(...ys) + inset, x1: Math.max(...xs) - inset, y1: Math.max(...ys) - inset };
}

/** Display-space rect that is actually visible under cover-fit for a canvas of this size (video 16:9). */
function visibleDisplayRect(cssW: number, cssH: number, srcW = 640, srcH = 360) {
  const canvasAspect = cssW / cssH;
  const videoAspect = srcW / srcH;
  if (canvasAspect >= videoAspect) {
    const visH = videoAspect / canvasAspect;
    return { x0: 0, x1: 1, y0: (1 - visH) / 2, y1: (1 - visH) / 2 + visH };
  }
  const visW = canvasAspect / videoAspect;
  return { x0: (1 - visW) / 2, x1: (1 - visW) / 2 + visW, y0: 0, y1: 1 };
}

/** Converts a normalized (video-space) rect into canvas-pixel fractions through cover-fit. */
function toCanvasFractions(rect: { x0: number; y0: number; x1: number; y1: number }, box: { x: number; y: number; width: number; height: number }) {
  const r = coverRect({ x: 0, y: 0, width: box.width, height: box.height }, 640, 360);
  const f = (nx: number, ny: number) => ({ x: (r.x + nx * r.w) / box.width, y: (r.y + ny * r.h) / box.height });
  const a = f(rect.x0, rect.y0);
  const b = f(rect.x1, rect.y1);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

test.describe('hand window (mock tracking)', () => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 }, // portrait phone: cover-fit crops the sides; the quad must still land where the tips are
  ]) {
  test(`quad appears with two hands and disappears with none @ ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const con = captureConsole(page);
    await startMockSession(page);
    const box = await canvasBox(page);

    // Baseline: no hands → no window.
    await holdSample(page, POSES.wide, { handCount: 0 });
    await waitFrames(page, 10);
    const noHands = await stagePixels(page);

    // Two hands → window visible inside the expected bbox.
    await holdSample(page, POSES.wide, { handCount: 2 });
    await waitFrames(page, 20);
    const twoHands = await stagePixels(page);

    const bb = quadBBox(POSES.wide);
    // Clip the expected bbox to the visible cover-fit rect (portrait viewports crop the sides).
    const vis = visibleDisplayRect(box.width, box.height);
    const inside = toCanvasFractions({ x0: Math.max(bb.x0, vis.x0 + 0.02), y0: Math.max(bb.y0, vis.y0 + 0.02), x1: Math.min(bb.x1, vis.x1 - 0.02), y1: Math.min(bb.y1, vis.y1 - 0.02) }, box);
    const insideDiff = regionDiff(noHands, twoHands, inside);
    // Far outside the window (top strip above the head) nothing but HUD may change.
    const outsideDiff = regionDiff(noHands, twoHands, { x0: 0.0, y0: 0.0, x1: 1.0, y1: 0.05 });
    expect(insideDiff, 'pixels inside the quad change when the window opens').toBeGreaterThan(8);
    expect(outsideDiff, 'pixels far outside the quad stay the same').toBeLessThan(insideDiff / 3);

    // One hand only → no window (contract: two hands required).
    await holdSample(page, POSES.wide, { handCount: 1 });
    await waitFrames(page, 40); // > holdMs + fadeMs at 60 Hz
    const oneHand = await stagePixels(page);
    expect(regionDiff(noHands, oneHand, inside), 'window hidden again with one hand').toBeLessThan(insideDiff / 3);
    con.assertClean();
  });
  }

  test('a window held entirely in the left half renders on screen-left (mirroring applied exactly once)', async ({ page }) => {
    await startMockSession(page);
    const box = await canvasBox(page);
    // Both hands in the left half: tips span x 0.17..0.45; a doubly-mirrored quad would land at 0.55..0.83.
    const shift = (h: MockSample['hands'][number], dx: number) => ({
      side: h.side,
      palmCenter: { x: h.palmCenter.x + dx, y: h.palmCenter.y },
      indexTip: { x: h.indexTip.x + dx, y: h.indexTip.y },
      thumbTip: { x: h.thumbTip.x + dx, y: h.thumbTip.y },
    });
    const leftHalf: MockSample = { ...POSES.wide, hands: [shift(POSES.wide.hands[0]!, 0), shift(POSES.wide.hands[1]!, -0.38)] };
    await holdSample(page, leftHalf, { handCount: 0 });
    await waitFrames(page, 10);
    const base = await stagePixels(page);
    await holdSample(page, leftHalf, { handCount: 2 });
    await waitFrames(page, 20);
    const shown = await stagePixels(page);
    const bbox = quadBBox(leftHalf);
    expect(bbox.x1).toBeLessThan(0.5);
    const real = toCanvasFractions(bbox, box);
    const mirrored = toCanvasFractions({ x0: 1 - bbox.x1, y0: bbox.y0, x1: 1 - bbox.x0, y1: bbox.y1 }, box);
    const realDiff = regionDiff(base, shown, real);
    const mirrorDiff = regionDiff(base, shown, mirrored);
    expect(realDiff, 'window content where the screen-left tips are').toBeGreaterThan(8);
    expect(mirrorDiff, 'no window content where a doubly-mirrored quad would be').toBeLessThan(realDiff / 3);
  });

  test('together → open cycles persona exactly once', async ({ page }) => {
    await startMockSession(page);
    const group = page.getByRole('radiogroup', { name: /persona/i });
    await expect(group, 'persona segmented control (contract §W1.7)').toBeVisible();
    const current = () => group.getByRole('radio', { checked: true }).textContent();
    const before = await current();

    // In-page timed sequence: together 800 ms (> togetherArmMs 500) → wide (open) held.
    const [tTogether, tOpen] = await holdSequence(page, [
      { sample: POSES.together, ms: 800, opts: { handCount: 2 } },
      { sample: POSES.wide, ms: 0, opts: { handCount: 2 } },
    ]);
    expect(tOpen! - tTogether!, 'together pose actually held ≥ 500 ms').toBeGreaterThanOrEqual(500);
    await expect.poll(current, { timeout: 5000, message: 'persona advanced after together→open' }).not.toBe(before);
    const after = await current();

    // Staying open must not cycle again (debounce 1500 ms + disarm).
    await page.waitForTimeout(1700);
    expect(await current()).toBe(after);
    await stopMock(page);
  });

  test('short together (< togetherArmMs) does not cycle', async ({ page }) => {
    await startMockSession(page);
    const group = page.getByRole('radiogroup', { name: /persona/i });
    const current = () => group.getByRole('radio', { checked: true }).textContent();
    const before = await current();
    const [tTogether, tOpen] = await holdSequence(page, [
      { sample: POSES.together, ms: 200, opts: { handCount: 2 } },
      { sample: POSES.wide, ms: 0, opts: { handCount: 2 } },
    ]);
    const heldMs = tOpen! - tTogether!;
    expect(heldMs, 'in-page sequencing keeps the short pose short').toBeLessThan(450);
    await page.waitForTimeout(1000);
    expect(await current(), `held ${Math.round(heldMs)} ms (< 500) must not cycle`).toBe(before);
  });
});
