/**
 * Shared e2e helpers (owner: W10). Selectors are derived from the shared UI contract
 * (accessible names, not CSS classes). If the UI ships different names, change ONLY this file
 * (see docs/testing.md "Selector contract").
 */
import { expect, type ConsoleMessage, type Page, type Locator } from '@playwright/test';
import { installMockDriver, waitForInjectHook, type MockSample } from './mockTracking';
import { withWebmDuration } from './webm';

export const SEL = {
  /** Onboarding primary actions. */
  useCamera: /use camera/i,
  openFile: /open a video file/i,
  /** Stage canvas (`<canvas id="stage">`). */
  stage: '#stage',
  /** Controls bar. */
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

/**
 * Exact accessible names of the v0.2 UI (shared UI contract). Specs select by these; if the UI
 * renames something, change it here only.
 */
export const NAMES = {
  /** `role="progressbar"` while the tracking models download (aria-valuenow 0..100). */
  loadingBar: 'Loading tracking models',
  /** `role="alert"` card text + its two buttons. */
  trackerFailure: 'Tracking models could not be loaded',
  retryTracking: 'Retry tracking',
  continueWithoutTracking: 'Continue without tracking',
  /** `role="status"` coach hint until the window opens once. */
  coachHint: 'Raise both hands in an L shape — index up, thumb in',
  dismissHint: 'Dismiss hint',
  /** Self-timer `role="status"` texts and the cancel button. */
  recordCountdown: /Recording starts in \d/,
  snapshotCountdown: /Snapshot in \d/,
  cancelCountdown: 'Cancel countdown',
  /** Recording controls / indicator. */
  startRecording: 'Start recording',
  stopRecording: 'Stop recording',
  recordingIndicator: /^Recording, \d\d:\d\d/,
  /** File transport (`<nav aria-label="Playback">`). */
  playback: 'Playback',
  play: 'Play',
  pause: 'Pause',
  seek: 'Seek',
  loop: 'Loop',
  /** Settings sheet (dialog title) and its groups / controls. */
  settingsTitle: 'Settings',
  groups: { interaction: 'Window & gestures', quality: 'Quality', look: 'Look', hud: 'HUD', display: 'Display', capture: 'Capture', diagnostics: 'Diagnostics' },
  displayFit: 'Display fit',
  fitOptions: { fill: 'Fill', fit: 'Fit' },
  selfTimer: 'Self-timer',
  autoStop: 'Auto-stop',
  snapshotFormat: 'Snapshot format',
  holdStill: 'Hold still to capture',
  holdStillOptions: { off: 'Off', snapshot: 'Snapshot', record: 'Record' },
  holdTime: 'Hold time',
  trackingResolution: 'Tracking resolution',
  faceStride: 'Face every N frames',
  cornerSmoothing: 'Corner smoothing',
  look: { inkThickness: 'Ink thickness', inkThreshold: 'Ink threshold', halftone: 'Halftone', saturation: 'Saturation', bands: 'Colour bands', grain: 'Grain', overlayStrength: 'Overlay strength', reset: 'Reset look' },
  diagnosticsRows: ['Tracking', 'Frame', 'Tracking time', 'Render time', 'GPU time', 'Quality', 'Renderer', 'Source'],
  copyDiagnostics: 'Copy diagnostics',
  resetDefaults: 'Reset to defaults',
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

export interface Box { x: number; y: number; width: number; height: number }
export type FitModeName = 'cover' | 'contain';

/**
 * Presentation mapping used by the renderer's present pass. The video frame (aspect `srcW/srcH`)
 * is scaled uniformly and centred: `cover` (Settings → Display fit → Fill, the default) fills the
 * canvas and crops; `contain` (Fit) letterboxes — the whole frame is visible and the rest of the
 * canvas is painted black. Returns the CSS-px rectangle the video occupies, so normalized display
 * coords map as  screenX = rect.x + nx * rect.w,  screenY = rect.y + ny * rect.h.
 */
export function fitRect(mode: FitModeName, box: Box, srcW: number, srcH: number) {
  const scale = mode === 'contain' ? Math.min(box.width / srcW, box.height / srcH) : Math.max(box.width / srcW, box.height / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, w, h };
}

/** Cover-fit mapping (v0.1 behaviour and the default): see `fitRect`. */
export function coverRect(box: Box, srcW: number, srcH: number) {
  return fitRect('cover', box, srcW, srcH);
}

/**
 * Letterbox bars of a `contain` fit as canvas-fraction rects (empty when the aspects match). Two
 * bars: top/bottom when the canvas is taller than the video, left/right when it is wider.
 */
export function containBars(box: Box, srcW: number, srcH: number): { axis: 'y' | 'x' | null; bars: { x0: number; y0: number; x1: number; y1: number }[] } {
  const r = fitRect('contain', box, srcW, srcH);
  const left = (r.x - box.x) / box.width;
  const top = (r.y - box.y) / box.height;
  if (top > 0.005) return { axis: 'y', bars: [{ x0: 0, y0: 0, x1: 1, y1: top }, { x0: 0, y0: 1 - top, x1: 1, y1: 1 }] };
  if (left > 0.005) return { axis: 'x', bars: [{ x0: 0, y0: 0, x1: left, y1: 1 }, { x0: 1 - left, y0: 0, x1: 1, y1: 1 }] };
  return { axis: null, bars: [] };
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

/** Fraction (0..1) of pixels in a normalized rect that satisfy `pred`. */
export function regionFraction(a: { width: number; height: number; data: Uint8Array }, rect: { x0: number; y0: number; x1: number; y1: number }, pred: (r: number, g: number, b: number) => boolean): number {
  const x0 = Math.max(0, Math.floor(rect.x0 * a.width));
  const x1 = Math.min(a.width, Math.ceil(rect.x1 * a.width));
  const y0 = Math.max(0, Math.floor(rect.y0 * a.height));
  const y1 = Math.min(a.height, Math.ceil(rect.y1 * a.height));
  let hit = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      if (pred(a.data[i]!, a.data[i + 1]!, a.data[i + 2]!)) hit++;
      n++;
    }
  }
  return n ? hit / n : 0;
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

/**
 * Current `aria-valuenow` of the "Loading tracking models" progressbar, or null when the bar is absent.
 *
 * Poll-safe by construction: presence and value are read in ONE browser-side step (`evaluateAll`
 * never autowaits; an empty match yields null). The obvious `count()` then `getAttribute()` is a
 * race — the bar legitimately disappears the moment the tracker is ready, and a locator ACTION
 * issued after a positive presence check autowaits on the now-missing element until the poll's
 * deadline, which reads like a loading stall. See the "loading progress poll helper" test.
 */
export async function readLoadingProgress(page: Page): Promise<number | null> {
  return page.getByRole('progressbar', { name: NAMES.loadingBar }).evaluateAll((els) => {
    const el = els[0];
    if (!el) return null;
    const v = el.getAttribute('aria-valuenow');
    return v === null ? null : Number(v);
  });
}

/** Open the Settings sheet (button in the controls bar) and return the dialog locator. */
export async function openSettings(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: NAMES.settingsTitle });
  if ((await dialog.count()) === 0) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Close any open dialog with Escape. */
export async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
}

/** Pick an option in a segmented control (radiogroup) of the Settings sheet by its accessible names. */
export async function chooseSegment(dialog: Locator, group: string, option: string): Promise<void> {
  const radio = dialog.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name: option, exact: true });
  await radio.click();
  await expect(radio).toBeChecked();
}

/** Set a range slider through the keyboard (End/Home = max/min) so React receives real input events. */
export async function setSliderExtreme(slider: Locator, which: 'max' | 'min'): Promise<void> {
  await slider.focus();
  await slider.press(which === 'max' ? 'End' : 'Home');
}

/**
 * Generate a short WebM clip INSIDE the page with MediaRecorder on a 2D canvas (animated bars so the
 * frames differ) and return its bytes. MediaRecorder writes a live WebM (no duration) — the result
 * is patched with `withWebmDuration` so `<video>.duration` is finite and the seek slider has a range.
 * Returns null when the browser cannot record a canvas stream (callers skip with a reason).
 */
export async function makeWebmFixture(page: Page, seconds = 2): Promise<{ name: string; mimeType: string; buffer: Buffer } | null> {
  const result = await page.evaluate(async (secs) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') return null;
    const mime = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return null;
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
    const chunks: Blob[] = [];
    rec.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    const stopped = new Promise<void>((resolve) => rec.addEventListener('stop', () => resolve()));
    let frame = 0;
    let timer = 0;
    const draw = (): void => {
      frame++;
      ctx.fillStyle = `hsl(${(frame * 7) % 360} 60% 45%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#f2f2f4';
      ctx.fillRect((frame * 6) % canvas.width, 80, 60, 200);
      ctx.fillStyle = '#141216';
      ctx.font = '48px sans-serif';
      ctx.fillText(String(frame), 40, 60);
      timer = window.setTimeout(draw, 1000 / 30);
    };
    draw();
    rec.start(200);
    await new Promise((r) => setTimeout(r, secs * 1000));
    rec.stop();
    await stopped;
    window.clearTimeout(timer);
    for (const t of stream.getTracks()) t.stop();
    const blob = new Blob(chunks, { type: mime.split(';')[0] ?? 'video/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    return { mimeType: blob.type, b64: btoa(bin) };
  }, seconds);
  if (!result) return null;
  const live = new Uint8Array(Buffer.from(result.b64, 'base64'));
  const patched = withWebmDuration(live, seconds * 1000);
  return { name: `fixture-${seconds}s.webm`, mimeType: result.mimeType || 'video/webm', buffer: Buffer.from(patched) };
}

/**
 * Hold one pose perfectly still (the mock pushes identical corners every frame) — the hold-still
 * ("dwell") gesture. Resolves with the page time at which the first still frame reached the runtime.
 */
export async function holdStill(page: Page, sample: MockSample): Promise<number> {
  await page.evaluate((s) => window.__alterframeMock!.hold(s, { handCount: 2 }), sample);
  await page.waitForFunction(() => window.__alterframeMock!.firstPushAt > 0 && performance.now() - window.__alterframeMock!.firstPushAt < 5000);
  return page.evaluate(() => window.__alterframeMock!.firstPushAt);
}
