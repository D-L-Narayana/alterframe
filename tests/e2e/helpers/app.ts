/**
 * Shared e2e helpers (owner: W10). Selectors are derived from the W1 contract
 * (ten-worker-contracts.md §W1): accessible names, not CSS classes. If W1 ships different
 * names, change ONLY this file (see docs/handoffs/W10.md "selector contract").
 */
import { expect, type ConsoleMessage, type Page, type Locator } from '@playwright/test';
import { installMockDriver, waitForInjectHook } from './mockTracking';

export const SEL = {
  /** Onboarding primary actions (contract §W1.2). */
  useCamera: /use camera/i,
  openFile: /open a video file/i,
  /** Stage canvas (contract §W1.2: `<canvas id="stage">`). */
  stage: '#stage',
  /** Controls (contract §W1.7). */
  personaGroup: /persona/i,
  baseToggle: /base|comic/i,
  hudToggle: /hud/i,
  director: /director/i,
  record: /record/i,
  snapshot: /snapshot/i,
  settings: /settings/i,
  help: /help/i,
  mirror: /mirror/i,
  fpsBadge: /fps/i,
  privacyLine: /camera frames never leave your device/i,
} as const;

export interface ConsoleCapture {
  errors: string[];
  warnings: string[];
  pageErrors: string[];
  /** Fail the test if any error was logged (ignores known-benign noise). */
  assertClean(): void;
}

/** Messages that are environmental, not app bugs (SwiftShader, fake camera, MediaPipe GPU fallback). */
const BENIGN = [
  /SwiftShader/i,
  /GPU stall due to ReadPixels/i,
  /Automatic fallback to software WebGL/i,
  /WebGL: CONTEXT_LOST/i,
  /\[Violation\]/,
  /Download the React DevTools/i,
  /vite\] connecting|\[vite\] connected/i,
  /favicon\.ico/i,
  // TensorFlow Lite / MediaPipe logs INFO lines at console.error level in Chromium.
  /^INFO: Created TensorFlow Lite/,
  /XNNPACK delegate/,
];

export function captureConsole(page: Page): ConsoleCapture {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text();
    if (BENIGN.some((re) => re.test(text))) return;
    if (msg.type() === 'error') errors.push(text);
    else if (msg.type() === 'warning') warnings.push(text);
  });
  page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err)));
  return {
    errors,
    warnings,
    pageErrors,
    assertClean() {
      expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
      expect(errors, `console.error output:\n${errors.join('\n')}`).toEqual([]);
    },
  };
}

/** Navigate to the app. `mock: true` appends `?mockTracking=1` (dev-only hook). */
export async function gotoApp(page: Page, opts: { mock?: boolean; query?: Record<string, string> } = {}): Promise<void> {
  const params = new URLSearchParams(opts.query ?? {});
  if (opts.mock) params.set('mockTracking', '1');
  const qs = params.toString();
  await page.goto(`/${qs ? `?${qs}` : ''}`, { waitUntil: 'domcontentloaded' });
}

export function stage(page: Page): Locator {
  return page.locator(SEL.stage);
}

/** Click "Use camera" on onboarding and wait for the stage canvas. */
export async function startCamera(page: Page, timeout = 60_000): Promise<Locator> {
  const btn = page.getByRole('button', { name: SEL.useCamera });
  await expect(btn, 'onboarding "Use camera" button (contract §W1.2)').toBeVisible({ timeout: 20_000 });
  await btn.click();
  const canvas = stage(page);
  await expect(canvas, 'stage canvas appears after camera start').toBeVisible({ timeout });
  return canvas;
}

/** Full mock-mode bootstrap: navigate, start camera, install driver, wait for inject hook. */
export async function startMockSession(page: Page): Promise<Locator> {
  await gotoApp(page, { mock: true });
  const canvas = await startCamera(page);
  await installMockDriver(page);
  await waitForInjectHook(page);
  return canvas;
}

/** Robust reading of the stage canvas' bounding box in CSS px. */
export async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await stage(page).boundingBox();
  if (!box) throw new Error('stage canvas has no bounding box');
  return box;
}

/**
 * Cover-fit mapping used by the renderer (plan §2 step 6): the video frame (aspect `srcW/srcH`)
 * is scaled to cover the canvas and centre-cropped. Returns the CSS-px rectangle of the visible
 * video inside the canvas box, so normalized display coords map as
 *   screenX = rect.x + nx * rect.w,  screenY = rect.y + ny * rect.h.
 */
export function coverRect(box: { x: number; y: number; width: number; height: number }, srcW: number, srcH: number) {
  const scale = Math.max(box.width / srcW, box.height / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, w, h };
}

/** Normalized display coordinate → page CSS pixel, through cover-fit. */
export function toScreen(nx: number, ny: number, box: { x: number; y: number; width: number; height: number }, srcW = 640, srcH = 360) {
  const r = coverRect(box, srcW, srcH);
  return { x: r.x + nx * r.w, y: r.y + ny * r.h };
}

/**
 * Grab the RGBA pixels of the stage canvas, downsampled in-page (draw into a 2D canvas) so the
 * payload stays small. Works for WebGL canvases because the renderer keeps `preserveDrawingBuffer`.
 */
export async function stagePixels(page: Page, width = 320): Promise<{ width: number; height: number; data: Uint8Array }> {
  const res = await page.evaluate((w) => {
    const c = document.querySelector<HTMLCanvasElement>('#stage');
    if (!c) throw new Error('#stage missing');
    const h = Math.max(1, Math.round((c.height / c.width) * w));
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(c, 0, 0, w, h);
    const bytes = ctx.getImageData(0, 0, w, h).data;
    // Base64 in 32 kB chunks: far cheaper to transfer than a JSON array of numbers.
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    return { w, h, b64: btoa(bin) };
  }, width);
  return { width: res.w, height: res.h, data: new Uint8Array(Buffer.from(res.b64, 'base64')) };
}

/** Mean RGB of a normalized rect of a pixel buffer. */
export function regionMean(a: { width: number; height: number; data: Uint8Array }, rect: { x0: number; y0: number; x1: number; y1: number }): [number, number, number] {
  const x0 = Math.max(0, Math.floor(rect.x0 * a.width));
  const x1 = Math.min(a.width, Math.ceil(rect.x1 * a.width));
  const y0 = Math.max(0, Math.floor(rect.y0 * a.height));
  const y1 = Math.min(a.height, Math.ceil(rect.y1 * a.height));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      r += a.data[i]!;
      g += a.data[i + 1]!;
      b += a.data[i + 2]!;
      n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

/** Mean absolute RGB difference between two equal-size RGBA buffers within a rect (fractions). */
export function regionDiff(
  a: { width: number; height: number; data: Uint8Array },
  b: { width: number; height: number; data: Uint8Array },
  rect: { x0: number; y0: number; x1: number; y1: number },
): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('size mismatch');
  const x0 = Math.max(0, Math.floor(rect.x0 * a.width));
  const x1 = Math.min(a.width, Math.ceil(rect.x1 * a.width));
  const y0 = Math.max(0, Math.floor(rect.y0 * a.height));
  const y1 = Math.min(a.height, Math.ceil(rect.y1 * a.height));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      sum += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}

/** Read the live `window.__alterframe` handle presence (dev-only). */
export async function hasRuntimeHandle(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof window.__alterframe !== 'undefined');
}

/** Read the app store (W1 `useAppStore`) if exposed for tests; otherwise null. */
export async function readScene(page: Page): Promise<{ base: string; persona: string; hudTint: string } | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __alterframeStore?: { getState(): { scene: { base: string; persona: string; hudTint: string } } } };
    return w.__alterframeStore ? w.__alterframeStore.getState().scene : null;
  });
}

/** Wait helper for `n` animation frames inside the page. */
export async function waitFrames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let i = 0;
        const tick = (): void => {
          if (++i >= count) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
}
