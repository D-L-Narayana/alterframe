/**
 * File playback transport (owner: W10). A 2 s WebM is generated IN THE BROWSER (MediaRecorder on a 2D
 * canvas, duration patched so the clip has a finite length), opened through the hidden file input on
 * onboarding, then: Playback nav → Pause → P → Seek → S snapshot while paused → Loop switch.
 * Home must move a clip paused at ≥ 0.8 s to 0 — the slider is the only control whose source of truth
 * updates asynchronously (the store learns the new position from the media's `seeked` event), so the
 * seek step starts from an explicit, non-vacuous nonzero position.
 * Chromium + SwiftShader; no camera involved. The only skip is environmental: a browser that cannot
 * record a canvas stream to WebM cannot produce the fixture.
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, makeWebmFixture, stage, NAMES } from './helpers/app';

async function openFixtureClip(page: Page): Promise<void> {
  const clip = await makeWebmFixture(page, 2);
  test.skip(!clip, 'this browser cannot record a canvas stream to WebM');
  await page.locator('input[type="file"]').first().setInputFiles(clip!);
  await expect(stage(page), 'stage appears for the opened file').toBeVisible({ timeout: 60_000 });
}

const seekValue = async (seek: ReturnType<Page['locator']>): Promise<number> => Number(await seek.inputValue());

test.describe('file transport', () => {
  test('Playback nav: Pause/Play label flips, P toggles, Seek moves the position, S snapshots while paused', async ({ page }) => {
    test.setTimeout(240_000);
    await gotoApp(page);
    await openFixtureClip(page);
    const nav = page.getByRole('navigation', { name: NAMES.playback });
    await expect(nav, 'Playback transport for file sources').toBeVisible({ timeout: 15_000 });

    const seek = nav.getByRole('slider', { name: NAMES.seek });
    await expect(seek).toBeVisible();
    await expect(seek, 'seek range covers the 2 s clip (duration known)').toHaveAttribute('max', /^(1\.\d+|2(\.\d+)?)$/);
    await expect(seek).toHaveAttribute('aria-valuetext', /^\d\d:\d\d$/);

    // Playing: the Pause button is shown.
    const pause = nav.getByRole('button', { name: NAMES.pause, exact: true });
    await expect(pause, 'clip autoplays → Pause offered').toBeVisible({ timeout: 10_000 });
    await pause.click();
    const play = nav.getByRole('button', { name: NAMES.play, exact: true });
    await expect(play, 'label flips to Play when paused').toBeVisible();
    const pausedAt = await seekValue(seek);
    await page.waitForTimeout(700);
    expect(Math.abs((await seekValue(seek)) - pausedAt), 'position frozen while paused').toBeLessThan(0.15);

    // P resumes, P pauses again.
    await page.keyboard.press('p');
    await expect(pause).toBeVisible();
    await page.keyboard.press('p');
    await expect(play).toBeVisible();

    // Precondition (non-vacuous): drive the PAUSED clip to its END through the keyboard path, which seeks
    // via `transport.seek` directly, not through the slider. `seek(min(duration, ct + 1))` lands on exactly
    // `duration` within two presses from anywhere in a 2 s clip. (App keys are ignored while a form control
    // has focus, so the slider is blurred first.)
    const max = Number(await seek.getAttribute('max'));
    const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    await seek.blur();
    for (let i = 0; i < 2 && (await seekValue(seek)) !== max; i++) {
      await page.keyboard.press(']');
      await expect.poll(() => seekValue(seek), { message: `] moves the paused clip forward (press ${i + 1})` }).toBeGreaterThan(i === 0 ? 0.8 : max - 0.2);
    }
    const start = await seekValue(seek);
    expect(start, 'precondition: paused at the end (max) before Home — the position the store will return to later').toBe(max);

    // Seek via the slider keyboard: Home → 0 (the slider's own path: input → seek → seeked → store → value).
    await seek.focus();
    await seek.press('Home');
    await expect.poll(() => seekValue(seek), { message: 'Home seeks to the start' }).toBeLessThan(0.2);
    await expect(seek).toHaveAttribute('aria-valuetext', '00:00');

    // Then ] / [ move ±1 s through the keyboard path (slider blurred again).
    await seek.blur();
    await page.keyboard.press(']');
    await expect.poll(() => seekValue(seek), { message: '] seeks +1 s' }).toBeGreaterThan(0.8);
    // Revival check: the store returns to EXACTLY the position the Home seek started from (max). A
    // completed seek must not re-activate its stale intent {value 0, base max} and show 0 while the
    // clip is at the end.
    await page.keyboard.press(']');
    await expect
      .poll(() => seekValue(seek), { message: 'back at the end: a completed Home seek must not revive its stale intent and show 0' })
      .toBeGreaterThanOrEqual(max - 0.2);
    await expect(seek).toHaveAttribute('aria-valuetext', mmss(max));
    await page.keyboard.press('[');
    await expect.poll(() => seekValue(seek), { message: '[ seeks −1 s from the end' }).toBeLessThanOrEqual(1.2);
    expect(await seekValue(seek), 'one second back from the end').toBeGreaterThanOrEqual(0.8);
    await page.keyboard.press('[');
    await expect.poll(() => seekValue(seek), { message: '[ seeks −1 s' }).toBeLessThan(0.2);

    // Snapshot while paused → PNG download.
    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.keyboard.press('s');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^alterframe-\d{8}-\d{6}\.png$/);
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync((await file.path())!);
    expect(Array.from(buf.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(buf.length).toBeGreaterThan(1000);
  });

  test('Loop switch toggles (click and L key); with Loop off the clip ends paused', async ({ page }) => {
    test.setTimeout(240_000);
    await gotoApp(page);
    await openFixtureClip(page);
    const nav = page.getByRole('navigation', { name: NAMES.playback });
    await expect(nav).toBeVisible({ timeout: 15_000 });

    const loop = nav.getByRole('switch', { name: NAMES.loop, exact: true });
    await expect(loop, 'file sources loop by default').toHaveAttribute('aria-checked', 'true');
    await loop.click();
    await expect(loop).toHaveAttribute('aria-checked', 'false');
    await loop.blur();
    await page.keyboard.press('l');
    await expect(loop, 'L toggles loop').toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('l');
    await expect(loop).toHaveAttribute('aria-checked', 'false');

    // Loop off: once the 2 s clip ends it stays paused at the end (Play offered, position ≈ duration).
    await expect(nav.getByRole('button', { name: NAMES.play, exact: true }), 'clip ends paused with loop off').toBeVisible({ timeout: 15_000 });
    const seek = nav.getByRole('slider', { name: NAMES.seek });
    const max = Number(await seek.getAttribute('max'));
    expect(Number(await seek.inputValue())).toBeGreaterThan(max - 0.3);
  });
});
