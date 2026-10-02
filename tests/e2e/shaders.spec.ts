/**
 * Shader compile (owner: W10, verifies W5 via W4): every pass of every STYLE_PRESETS entry
 * compiles and links on real WebGL2 (SwiftShader in CI) — through W4 `compilePass` when
 * exported AND against the contract prelude from src/types/render.ts.
 */
import { test, expect } from '@playwright/test';
import type { ShaderResult } from './pages/shaders';

test('all style passes compile on WebGL2', async ({ page }) => {
  await page.goto('/tests/e2e/pages/shaders.html');
  await page.waitForFunction(() => window.__shaderResults?.done === true, undefined, { timeout: 60_000 });
  const state = await page.evaluate(() => window.__shaderResults!);
  expect(state.error, 'harness error (styles module missing or WebGL2 unavailable)').toBeUndefined();
  const results: ShaderResult[] = state.results;
  expect(results.length, 'at least one pass per preset').toBeGreaterThanOrEqual(2);
  const presets = new Set(results.map((r) => r.preset));
  expect([...presets].sort()).toEqual(['comic', 'paper-portrait']);
  const failures = results.filter((r) => !r.ok).map((r) => `${r.preset}/${r.pass} [${r.via}]: ${r.log}`);
  expect(failures, 'shader compile/link failures').toEqual([]);
});

test('passes are ordered as the contract prescribes', async ({ page }) => {
  await page.goto('/tests/e2e/pages/shaders.html');
  await page.waitForFunction(() => window.__shaderResults?.done === true, undefined, { timeout: 60_000 });
  const results = await page.evaluate(() => window.__shaderResults!.results);
  const order = (preset: string) => results.filter((r) => r.preset === preset).map((r) => r.pass);
  // §W5.3: paper-portrait = smooth → quantize → ink → grade; comic = smooth → quantize → ink → halftone → backdrop → grade.
  expect(order('paper-portrait').join(' > ')).toMatch(/smooth.*quantize.*ink.*grade/);
  expect(order('comic').join(' > ')).toMatch(/smooth.*quantize.*ink.*halftone.*backdrop.*grade/);
});
