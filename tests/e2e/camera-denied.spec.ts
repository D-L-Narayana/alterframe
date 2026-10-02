/**
 * A12 (owner: W10): camera denied / unavailable → clear message + retry + file fallback.
 * getUserMedia is stubbed via addInitScript (Chromium's fake UI flag cannot simulate a denial).
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, SEL } from './helpers/app';

async function stubGetUserMedia(page: Page, errorName: 'NotAllowedError' | 'NotFoundError'): Promise<void> {
  await page.addInitScript((name) => {
    const md = navigator.mediaDevices;
    Object.defineProperty(md, 'getUserMedia', {
      configurable: true,
      value: () => Promise.reject(new DOMException(`${name} (e2e stub)`, name)),
    });
  }, errorName);
}

test('denied permission shows an error panel with retry and the file fallback', async ({ page }) => {
  await stubGetUserMedia(page, 'NotAllowedError');
  await gotoApp(page);
  await page.getByRole('button', { name: SEL.useCamera }).click();
  const alert = page.getByRole('alert').first();
  await expect(alert, 'ErrorPanel for denied (contract §W1.2)').toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText(/denied|permission|blocked/i);
  await expect(page.getByRole('button', { name: /retry|try again/i })).toBeVisible();
  await expect(page.getByRole('button', { name: SEL.openFile })).toBeVisible();
});

test('no camera device shows "unavailable" messaging', async ({ page }) => {
  await stubGetUserMedia(page, 'NotFoundError');
  await gotoApp(page);
  await page.getByRole('button', { name: SEL.useCamera }).click();
  await expect(page.getByText(/no camera|unavailable|not found/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: SEL.openFile })).toBeVisible();
});

test('status region is polite live region', async ({ page }) => {
  await stubGetUserMedia(page, 'NotAllowedError');
  await gotoApp(page);
  await page.getByRole('button', { name: SEL.useCamera }).click();
  const live = page.locator('[aria-live="polite"], [role="status"], [role="alert"]');
  await expect(live.first(), 'aria-live status for permission errors (A11)').toBeVisible({ timeout: 15_000 });
});
