/**
 * Accessibility (owner: W10): axe-core on onboarding, stage, settings (all groups), help, the tracker
 * failure card and the file transport; 0 serious/critical violations; keyboard reachability of the
 * main controls; focus trap.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { gotoApp, startCamera, makeWebmFixture, stage, SEL, NAMES } from './helpers/app';

async function axe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']).analyze();
  const severe = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = severe.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`).join('\n');
  expect(severe, `${label}: serious/critical axe violations\n${summary}`).toEqual([]);
}

test.describe('a11y', () => {
  test('onboarding has no serious/critical violations', async ({ page }) => {
    await gotoApp(page);
    await expect(page.getByRole('button', { name: SEL.useCamera })).toBeVisible();
    await axe(page, 'onboarding');
  });

  test('stage + controls', async ({ page }) => {
    await gotoApp(page);
    await startCamera(page);
    await axe(page, 'stage');
  });

  test('settings sheet (all groups) and help dialog', async ({ page }) => {
    test.slow(); // axe over the full sheet on SwiftShader
    await gotoApp(page);
    await startCamera(page);
    await page.getByRole('button', { name: SEL.settings }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Every group is present (axe analyses the whole DOM, so no scrolling is needed — the Diagnostics
    // rows refresh at 2 Hz, which keeps the sheet "unstable" for scroll actions).
    for (const group of Object.values(NAMES.groups)) {
      await expect(dialog.getByRole('heading', { name: group, exact: true }), `Settings group "${group}"`).toBeAttached();
    }
    await axe(page, 'settings');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.keyboard.press('?');
    const help = page.getByRole('dialog');
    await expect(help, 'help dialog opens with ?').toBeVisible();
    await expect(help.getByText(/record/i).first()).toBeVisible();
    await axe(page, 'help');
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
  });

  test('tab order reaches every main control and focus is visible', async ({ page }) => {
    test.slow(); // SwiftShader: each key round trip waits for the main thread between inferences
    await gotoApp(page);
    await startCamera(page);
    const names = new Set<string>();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
          role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
          outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
          shadow: cs.boxShadow !== 'none',
        };
      });
      if (!info) continue;
      if (info.role === 'button' || info.role === 'radio' || info.role === 'switch' || info.role === 'slider') {
        names.add(info.name.toLowerCase());
        expect(info.outline || info.shadow, `visible focus indicator on "${info.name}"`).toBeTruthy();
      }
    }
    const joined = [...names].join(' | ');
    for (const re of [SEL.record, SEL.snapshot, SEL.settings, SEL.help, SEL.director]) {
      expect(joined, `control ${re} reachable by Tab`).toMatch(re);
    }
  });

  test('tracker failure card (models blocked) has no serious/critical violations and is keyboard reachable', async ({ page }) => {
    test.setTimeout(300_000);
    await page.route('**/models/*', (route) => route.abort('failed'));
    await gotoApp(page);
    await startCamera(page);
    const card = page.getByRole('alert').filter({ hasText: NAMES.trackerFailure });
    await expect(card, 'blocked downloads end in the failure card').toBeVisible({ timeout: 120_000 });
    await expect(card.getByRole('heading', { name: NAMES.trackerFailure })).toBeVisible();
    await card.getByRole('button', { name: NAMES.retryTracking }).focus();
    await expect(card.getByRole('button', { name: NAMES.retryTracking })).toBeFocused();
    await axe(page, 'tracker failure card');
  });

  test('file transport has no serious/critical violations and its controls are named', async ({ page }) => {
    test.slow();
    await gotoApp(page);
    const clip = await makeWebmFixture(page, 1);
    test.skip(!clip, 'this browser cannot record a canvas stream to WebM');
    await page.locator('input[type="file"]').first().setInputFiles(clip!);
    await expect(stage(page)).toBeVisible({ timeout: 60_000 });
    const nav = page.getByRole('navigation', { name: NAMES.playback });
    await expect(nav).toBeVisible({ timeout: 15_000 });
    await expect(nav.getByRole('slider', { name: NAMES.seek })).toBeVisible();
    await expect(nav.getByRole('switch', { name: NAMES.loop, exact: true })).toBeVisible();
    await expect(nav.getByRole('button', { name: /^(Play|Pause)$/ })).toBeVisible();
    await axe(page, 'transport');
  });

  test('dialog traps focus and restores it on close', async ({ page }) => {
    test.slow(); // SwiftShader: each key round trip waits for the main thread between inferences
    await gotoApp(page);
    await startCamera(page);
    const settings = page.getByRole('button', { name: SEL.settings });
    await settings.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return Boolean(d && document.activeElement && d.contains(document.activeElement));
      });
      expect(inside, 'focus stays inside the open dialog').toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(settings, 'focus returns to the opener').toBeFocused();
  });
});
