/**
 * Accessibility (owner: W10): axe-core on onboarding, stage, settings and help;
 * 0 serious/critical violations; keyboard reachability of the main controls.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { gotoApp, startCamera, SEL } from './helpers/app';

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

  test('settings sheet and help dialog', async ({ page }) => {
    await gotoApp(page);
    await startCamera(page);
    await page.getByRole('button', { name: SEL.settings }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
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

  test('dialog traps focus and restores it on close', async ({ page }) => {
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
