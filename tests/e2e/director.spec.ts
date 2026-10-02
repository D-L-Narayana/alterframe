/**
 * Director (owner: W10): the D key / Director button starts the REFERENCE_SEQUENCE loop and the
 * UI reflects scene changes (base toggle, persona). Timings are long (23.6 s loop), so we only
 * check the first transition region using the Director UI state and the base control.
 */
import { test, expect } from '@playwright/test';
import { REFERENCE_SEQUENCE } from '@/types';
import { startMockSession, SEL } from './helpers/app';
import { holdSample, POSES } from './helpers/mockTracking';

test.describe('director', () => {
  test('Director button toggles running state and is keyboard reachable (D)', async ({ page }) => {
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const btn = page.getByRole('button', { name: SEL.director });
    await expect(btn, 'Director play/stop control (contract §W1.7)').toBeVisible();
    const before = (await btn.getAttribute('aria-pressed')) ?? (await btn.textContent());
    await page.keyboard.press('d');
    await expect.poll(async () => (await btn.getAttribute('aria-pressed')) ?? (await btn.textContent())).not.toBe(before);
    await page.keyboard.press('d');
    await expect.poll(async () => (await btn.getAttribute('aria-pressed')) ?? (await btn.textContent())).toBe(before);
  });

  test('sequence step 0 is live/portrait and step 1 (after 13.8 s) is masked', async ({ page }) => {
    test.slow();
    await startMockSession(page);
    await holdSample(page, POSES.wide);
    const group = page.getByRole('radiogroup', { name: /persona/i });
    const personaNow = async () => ((await group.getByRole('radio', { checked: true }).textContent()) ?? '').toLowerCase();

    await page.keyboard.press('d');
    await page.waitForTimeout(500);
    expect(await personaNow()).toMatch(/portrait|1/);
    const step0 = REFERENCE_SEQUENCE[0]!;
    await page.waitForTimeout(step0.durationMs + 400);
    expect(await personaNow(), 'Director moved to step 1 (masked)').toMatch(/mask|2/);
    await page.keyboard.press('d');
  });
});
