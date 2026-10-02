/**
 * Visual baselines (owner: W10). Runs in the `visual` Playwright project, whose fake camera plays
 * the STATIC fixture (tests/fixtures/hands-still.y4m = 1 s of the skewed pose, looped) so the base
 * layer is deterministic. Mock tracking holds the matching skewed pose. HUD callouts are switched
 * off for the persona×base baselines because their 2-digit prefix re-rolls every 800 ms; the HUD
 * is covered by a pixel assertion below instead.
 *
 * Baselines live in tests/e2e/__screenshots__/ (create with `npm run test:visual:update`, then
 * commit). In CI the baseline tests are skipped until they exist.
 *
 * Honest scope: this verifies our procedural stylization renders deterministically — it is an
 * approximation of the illustrated look, not a replica of any footage.
 */
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockSession, stage, stagePixels, canvasBox, coverRect } from './helpers/app';
import { holdSample, POSES } from './helpers/mockTracking';

const baselineDir = fileURLToPath(new URL('./__screenshots__/visual.spec.ts', import.meta.url));
const PERSONAS = [
  { key: '1', name: 'portrait' },
  { key: '2', name: 'masked' },
  { key: '3', name: 'suit' },
] as const;

test.describe('visual baselines', () => {
  test.skip(Boolean(process.env.CI) && !existsSync(baselineDir), 'no committed baselines yet; run npm run test:visual:update locally');

  for (const base of ['live', 'comic'] as const) {
    for (const p of PERSONAS) {
      test(`${p.name} on ${base}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' }); // deterministic backdrop parallax / blink
        await startMockSession(page);
        await holdSample(page, POSES.skewed, { mouthOpen: 0.1 });
        await page.keyboard.press(p.key);
        if (base === 'comic') await page.keyboard.press('b');
        await page.keyboard.press('h'); // HUD off (random prefix)
        await page.waitForTimeout(1500);
        await expect(stage(page)).toHaveScreenshot(`${p.name}-${base}.png`, { maxDiffPixelRatio: 0.02 });
      });
    }
  }
});

/** Count pixels in a normalized rect matching a predicate. */
function countWhere(px: { width: number; height: number; data: Uint8Array }, rect: { x0: number; y0: number; x1: number; y1: number }, pred: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = Math.floor(rect.y0 * px.height); y < Math.ceil(rect.y1 * px.height); y++) {
    for (let x = Math.floor(rect.x0 * px.width); x < Math.ceil(rect.x1 * px.width); x++) {
      const i = (y * px.width + x) * 4;
      if (pred(px.data[i]!, px.data[i + 1]!, px.data[i + 2]!)) n++;
    }
  }
  return n;
}

test.describe('HUD tint (pixel assertions, no baseline needed)', () => {
  test('corner callout is drawn red on comic base and white on live base; hidden when HUD is off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startMockSession(page);
    await holdSample(page, POSES.skewed);
    await page.keyboard.press('1');
    await page.waitForTimeout(800);
    const box = await canvasBox(page);
    // Corner callout anchors at quad corner TL = left index tip; the label sits above/right of it.
    const tl = POSES.skewed.hands[0]!.indexTip;
    const r = coverRect({ x: 0, y: 0, width: box.width, height: box.height }, 640, 360);
    const region = {
      x0: (r.x + (tl.x - 0.02) * r.w) / box.width,
      x1: (r.x + (tl.x + 0.16) * r.w) / box.width,
      y0: (r.y + (tl.y - 0.08) * r.h) / box.height,
      y1: (r.y + (tl.y + 0.01) * r.h) / box.height,
    };
    // Thin (300-weight) anti-aliased glyphs over the grey fixture: classify by brightness + saturation.
    const isRed = (R: number, G: number, B: number) => R > 160 && G < 120 && B < 120 && R - Math.max(G, B) > 60;
    const isWhite = (R: number, G: number, B: number) => Math.min(R, G, B) > 205 && Math.max(R, G, B) - Math.min(R, G, B) < 30;

    const live = await stagePixels(page, Math.round(box.width));
    const whiteLive = countWhere(live, region, isWhite);
    const redLive = countWhere(live, region, isRed);
    expect(whiteLive, 'white HUD pixels near the corner callout on live base').toBeGreaterThan(20);
    expect(redLive, 'no red HUD pixels on live base').toBeLessThan(whiteLive / 4);

    await page.keyboard.press('b');
    await page.waitForTimeout(800);
    const comic = await stagePixels(page, Math.round(box.width));
    const redComic = countWhere(comic, region, isRed);
    expect(redComic, 'red HUD pixels near the corner callout on comic base').toBeGreaterThan(20);

    await page.keyboard.press('h');
    await page.waitForTimeout(600);
    const off = await stagePixels(page, Math.round(box.width));
    expect(countWhere(off, region, isRed), 'HUD off removes the red callout').toBeLessThan(redComic / 4);
  });
});
