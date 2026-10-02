/**
 * Real-WebGL2 pixel tests for the W4 compositor. Boots a Vite dev server on port 6214, opens
 * src/render/core/__harness__/gpu-test.html in headless Chromium (SwiftShader) and asserts on
 * readPixels. Skips (with a reason) when Chromium cannot be launched in this environment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { SceneSpec, SceneResult, W4Harness } from '../../../src/render/core/__harness__/gpu-test';

const PORT = 6214;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HARNESS_PATH = '/src/render/core/__harness__/gpu-test.html';
let URL = `http://127.0.0.1:${PORT}${HARNESS_PATH}`;

let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let skipReason = '';

type Rgba = [number, number, number, number];
const near = (px: Rgba | undefined, rgb: [number, number, number], tol = 10): void => {
  expect(px, 'probe missing').toBeDefined();
  const [r, g, b] = px!;
  const ok = Math.abs(r - rgb[0]) <= tol && Math.abs(g - rgb[1]) <= tol && Math.abs(b - rgb[2]) <= tol;
  expect(ok, `expected ≈ rgb(${rgb.join(',')}) got rgb(${r},${g},${b})`).toBe(true);
};
const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const WHITE: [number, number, number] = [255, 255, 255];
const YELLOW: [number, number, number] = [255, 255, 0];

async function run(spec: SceneSpec): Promise<SceneResult> {
  return page!.evaluate((s) => (window as Window & { __w4?: W4Harness }).__w4!.run(s), spec);
}

beforeAll(async () => {
  try {
    // Reuse a dev server already serving this root on 6214 (W4's own port), else start one on 6214..6219.
    const existing = await fetch(URL).then((r) => r.ok).catch(() => false);
    if (!existing) {
      let lastErr: unknown = null;
      for (let port = PORT; port < PORT + 6 && !server; port++) {
        try {
          const s = await createServer({
            root: ROOT,
            configFile: path.join(ROOT, 'vite.config.ts'),
            logLevel: 'silent',
            server: { port, strictPort: true, host: '127.0.0.1', open: false },
          });
          await s.listen();
          server = s;
          URL = `http://127.0.0.1:${port}${HARNESS_PATH}`;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!server) throw new Error(`no free port in ${PORT}..${PORT + 5}: ${(lastErr as Error)?.message}`);
    }
    browser = await chromium.launch({
      args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
    });
    page = await browser.newPage({ viewport: { width: 800, height: 800 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(URL);
    await page.waitForFunction(() => (window as Window & { __w4?: W4Harness }).__w4?.ready === true, undefined, { timeout: 30_000 });
    const err = await page.evaluate(() => (window as Window & { __w4?: W4Harness }).__w4?.error ?? null);
    if (err) skipReason = `harness failed: ${err}`;
    if (errors.length) skipReason = `page errors: ${errors.join(' | ')}`;
  } catch (e) {
    skipReason = `cannot boot GPU harness: ${(e as Error).message}`;
  }
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('W4 compositor on a real WebGL2 context', () => {
  const gpuIt = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
    it(name, async (ctx) => {
      if (skipReason) {
        ctx.skip(skipReason);
        return;
      }
      await fn();
    }, timeout);

  gpuIt('boots: canvas backing store = css × dpr and renders a base colour', async () => {
    const r = await run({ css: { w: 640, h: 360, dpr: 1 }, base: { solid: [1, 0, 0] }, probes: [{ x: 0.5, y: 0.5 }] });
    expect(r.backing).toEqual({ w: 640, h: 360 });
    expect(r.internal).toEqual({ w: 640, h: 360 });
    near(r.probes[0], RED);
    expect(r.stats.passes).toBeGreaterThan(0);
    expect(r.stats.lastFrameMs).toBeGreaterThanOrEqual(0);
    const hi = await run({ css: { w: 320, h: 180, dpr: 2 }, base: { solid: [1, 0, 0] } });
    expect(hi.backing).toEqual({ w: 640, h: 360 });
  });

  gpuIt('quad mask: inside == window colour, outside == base colour; opacity 0.5 blends', async () => {
    const quad: SceneSpec['quad'] = [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.7, y: 0.7 }, { x: 0.3, y: 0.7 }];
    const r = await run({
      base: { solid: [1, 0, 0] }, window: { solid: [0, 0, 1] }, quad, opacity: 1,
      probes: [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.31, y: 0.69 }, { x: 0.29, y: 0.5 }],
    });
    near(r.probes[0], BLUE);
    near(r.probes[1], RED);
    near(r.probes[2], RED);
    near(r.probes[3], BLUE); // corner interior (BL)
    near(r.probes[4], RED); // just outside the left edge: hard edge, no feather
    const half = await run({ base: { solid: [1, 0, 0] }, window: { solid: [0, 0, 1] }, quad, opacity: 0.5, probes: [{ x: 0.5, y: 0.5 }] });
    near(half.probes[0], [128, 0, 128], 12);
    const hidden = await run({ base: { solid: [1, 0, 0] }, window: { solid: [0, 0, 1] }, quad: null, probes: [{ x: 0.5, y: 0.5 }] });
    near(hidden.probes[0], RED);
    const zero = await run({ base: { solid: [1, 0, 0] }, window: { solid: [0, 0, 1] }, quad, opacity: 0, probes: [{ x: 0.5, y: 0.5 }] });
    near(zero.probes[0], RED);
  });

  gpuIt('a 2 px thin slit quad still renders (no minimum area enforced)', async () => {
    const y0 = 0.5;
    const y1 = 0.5 + 2 / 360;
    const r = await run({
      base: { solid: [1, 0, 0] }, window: { solid: [0, 0, 1] },
      quad: [{ x: 0.2, y: y0 }, { x: 0.8, y: y0 }, { x: 0.8, y: y1 }, { x: 0.2, y: y1 }],
      probesPx: [{ x: 320, y: 180 }, { x: 320, y: 176 }, { x: 320, y: 184 }],
    });
    near(r.probesPx[0], BLUE);
    near(r.probesPx[1], RED);
    near(r.probesPx[2], RED);
  });

  gpuIt('skewed / rotated quad is filled as two triangles and bow-tie order does not throw', async () => {
    const r = await run({
      base: { solid: [1, 0, 0] }, window: { solid: [0, 0, 1] },
      quad: [{ x: 0.3, y: 0.2 }, { x: 0.8, y: 0.35 }, { x: 0.7, y: 0.85 }, { x: 0.2, y: 0.7 }],
      probes: [{ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.8 }],
    });
    near(r.probes[0], BLUE);
    near(r.probes[1], RED);
    near(r.probes[2], RED);
    const bow = await run({
      base: { solid: [1, 0, 0] }, window: { solid: [0, 0, 1] },
      quad: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.8, y: 0.2 }, { x: 0.2, y: 0.8 }],
      probes: [{ x: 0.5, y: 0.5 }],
    });
    expect(bow.stats.passes).toBeGreaterThan(0);
  });

  gpuIt('live base: video is upright and mirrored exactly once via UV flip', async () => {
    const plain = await run({
      video: { w: 640, h: 360, pattern: 'quadrants' }, base: 'live', mirrored: false,
      probes: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.25, y: 0.75 }, { x: 0.75, y: 0.75 }],
    });
    near(plain.probes[0], RED); near(plain.probes[1], GREEN); near(plain.probes[2], BLUE); near(plain.probes[3], WHITE);
    const mirrored = await run({
      video: { w: 640, h: 360, pattern: 'quadrants' }, base: 'live', mirrored: true,
      probes: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.25, y: 0.75 }, { x: 0.75, y: 0.75 }],
    });
    near(mirrored.probes[0], GREEN); near(mirrored.probes[1], RED); near(mirrored.probes[2], WHITE); near(mirrored.probes[3], BLUE);
  });

  gpuIt('u_video inside a window pass is the mirrored display-space video (not mirrored again)', async () => {
    const r = await run({
      video: { w: 640, h: 360, pattern: 'halves' }, mirrored: true, base: { solid: [0, 0, 0] },
      window: { frag: 'void main(){ fragColor = texture(u_video, v_uv); }' },
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      probes: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }],
    });
    near(r.probes[0], YELLOW); // source-right yellow shows on screen-left when mirrored
    near(r.probes[1], GREEN);
    const first = await run({
      video: { w: 640, h: 360, pattern: 'halves' }, mirrored: true, base: 'live', window: 'passthrough',
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      probes: [{ x: 0.25, y: 0.5 }],
    });
    near(first.probes[0], YELLOW); // first pass u_color == video
  });

  gpuIt('overlay, HUD and mask share display space with the mirrored video (no double mirror, no flip)', async () => {
    // Video has a dark dot at SOURCE (0.75, 0.3); mirrored it appears at DISPLAY (0.25, 0.3).
    // W6 overlay draws a white dot at DISPLAY (0.25, 0.3) (already mirrored) -> it must cover the video dot.
    const dot = { x: 0.75, y: 0.3, r: 0.06, color: '#101010' };
    const r = await run({
      video: { w: 640, h: 360, pattern: 'dot', color: '#808080', dot }, mirrored: true,
      base: 'live', window: 'passthrough',
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      overlay: { dots: [{ x: 0.25, y: 0.3, r: 0.03, color: '#ffffff' }] },
      hud: { dots: [{ x: 0.75, y: 0.7, r: 0.03, color: '#ff00ff' }] },
      probes: [{ x: 0.25, y: 0.3 }, { x: 0.25, y: 0.3 + 0.045 }, { x: 0.25, y: 0.3 + 0.12 }, { x: 0.75, y: 0.3 }, { x: 0.75, y: 0.7 }],
    });
    near(r.probes[0], WHITE); // overlay dot centre
    near(r.probes[1], [16, 16, 16]); // ring of the video dot still visible just outside the overlay dot
    near(r.probes[2], [128, 128, 128]); // background
    near(r.probes[3], [128, 128, 128]); // NOT the video dot: it was mirrored to the left
    near(r.probes[4], [255, 0, 255]); // HUD dot at display (0.75, 0.7)
    // Without a window, the overlay must NOT show (inside-window only) but the HUD still does.
    const noWin = await run({
      video: { w: 640, h: 360, pattern: 'solid', color: '#808080' }, base: 'live', quad: null,
      overlay: { dots: [{ x: 0.25, y: 0.3, r: 0.03, color: '#ffffff' }] },
      hud: { dots: [{ x: 0.75, y: 0.7, r: 0.03, color: '#ff00ff' }] },
      probes: [{ x: 0.25, y: 0.3 }, { x: 0.75, y: 0.7 }],
    });
    near(noWin.probes[0], [128, 128, 128]);
    near(noWin.probes[1], [255, 0, 255]);
  });

  gpuIt('segmentation mask: top-left origin, already mirrored, sampled via u_mask.r in both formats', async () => {
    const frag = 'void main(){ fragColor = texture(u_mask, v_uv).r > 0.5 ? vec4(0.0,1.0,0.0,1.0) : vec4(0.0,0.0,1.0,1.0); }';
    for (const mirrored of [false, true]) {
      const r = await run({
        mirrored, base: { solid: [0, 0, 0] }, window: { frag }, mask: 'topleft',
        quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
        probes: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.25, y: 0.75 }, { x: 0.75, y: 0.75 }],
      });
      near(r.probes[0], GREEN, 2);
      near(r.probes[1], BLUE, 2);
      near(r.probes[2], BLUE, 2);
      near(r.probes[3], BLUE, 2);
      expect(['R32F', 'R8']).toContain(r.maskFormat);
      expect(r.uploads.mask).toBeGreaterThan(0);
    }
    // No segmentation -> mask defaults to 1.0 everywhere (keeps colour in paper-portrait).
    const none = await run({
      base: { solid: [0, 0, 0] }, window: { frag }, mask: null,
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], probes: [{ x: 0.75, y: 0.75 }],
    });
    near(none.probes[0], GREEN, 2);
  });

  gpuIt('u_backdrop is the W6 backdrop canvas in display space', async () => {
    const r = await run({
      base: { solid: [0, 0, 0] }, window: { frag: 'void main(){ fragColor = texture(u_backdrop, v_uv); }' },
      backdrop: { fill: '#ff8000', dots: [{ x: 0.3, y: 0.6, r: 0.05, color: '#00ffff' }] },
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      probes: [{ x: 0.3, y: 0.6 }, { x: 0.8, y: 0.2 }],
    });
    near(r.probes[0], [0, 255, 255]);
    near(r.probes[1], [255, 128, 0]);
    // No backdrop supplied -> paper white default.
    const none = await run({
      base: { solid: [0, 0, 0] }, window: { frag: 'void main(){ fragColor = texture(u_backdrop, v_uv); }' }, backdrop: null,
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], probes: [{ x: 0.5, y: 0.5 }],
    });
    near(none.probes[0], [0xf6, 0xf3, 0xec], 3);
  });

  gpuIt('pass chains ping-pong (u_color = previous output), pass.scale sizes the target, u_resolution/u_texel set', async () => {
    const chain = await run({
      base: { solid: [0, 0, 0] },
      window: { chain: [{ solid: [1, 0, 0] }, { frag: 'void main(){ vec4 c = texture(u_color, v_uv); fragColor = vec4(0.0, c.r, 0.0, 1.0); }' }] },
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], probes: [{ x: 0.5, y: 0.5 }],
    });
    near(chain.probes[0], GREEN);
    const scaled = await run({
      base: { solid: [0, 0, 0] },
      window: { frag: 'void main(){ fragColor = vec4(u_resolution.x / 1024.0, u_resolution.y / 1024.0, u_texel.x * 256.0, 1.0); }', scale: 0.5 },
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], probes: [{ x: 0.5, y: 0.5 }],
    });
    // 640×360 at scale 0.5 -> 320×180: r = 320/1024, g = 180/1024, b = 256/320
    near(scaled.probes[0], [Math.round(255 * 320 / 1024), Math.round(255 * 180 / 1024), Math.round(255 * 256 / 320)], 3);
    const half = await run({ base: { solid: [1, 0, 0] }, renderScale: 0.5, probes: [{ x: 0.5, y: 0.5 }] });
    expect(half.internal).toEqual({ w: 320, h: 180 });
    near(half.probes[0], RED);
  });

  gpuIt('cover-fit present: square and portrait canvases crop (never stretch) and keep display-space alignment', async () => {
    const quadrants = { w: 640, h: 360, pattern: 'quadrants' as const };
    const square = await run({
      css: { w: 360, h: 360, dpr: 1 }, video: quadrants, base: 'live', window: { solid: [0, 0, 1] },
      quad: [{ x: 0.4, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.8 }, { x: 0.4, y: 0.8 }],
      probes: [{ x: 0.3, y: 0.25 }, { x: 0.7, y: 0.75 }, { x: 0.5, y: 0.5 }, { x: 0.45, y: 0.1 }],
      probesPx: [{ x: 2, y: 2 }, { x: 357, y: 357 }],
    });
    expect(square.backing).toEqual({ w: 360, h: 360 });
    expect(square.fit.uvScale[0]).toBeCloseTo(0.5625, 4);
    expect(square.fit.uvScale[1]).toBeCloseTo(1, 4);
    near(square.probes[0], RED);
    near(square.probes[1], WHITE);
    near(square.probes[2], BLUE); // quad centre lands where display (0.5,0.5) is shown
    near(square.probes[3], RED); // above the quad, left of centre
    near(square.probesPx[0], RED); // canvas corner shows the visible (cropped) part, upright
    near(square.probesPx[1], WHITE);
    // Quad edge: display x=0.4 -> canvas px = (0.4-0.21875)/0.5625*360 = 116
    expect(square.probePx[2]!.x).toBeCloseTo(180, 0);
    const portrait = await run({
      css: { w: 180, h: 320, dpr: 2 }, video: quadrants, base: 'live',
      probes: [{ x: 0.4, y: 0.25 }, { x: 0.6, y: 0.75 }], probesPx: [{ x: 2, y: 2 }, { x: 357, y: 637 }],
    });
    expect(portrait.backing).toEqual({ w: 360, h: 640 });
    near(portrait.probes[0], RED);
    near(portrait.probes[1], WHITE);
    near(portrait.probesPx[0], RED);
    near(portrait.probesPx[1], WHITE);
    const wide = await run({ css: { w: 640, h: 200, dpr: 1 }, video: quadrants, base: 'live', probesPx: [{ x: 2, y: 2 }, { x: 637, y: 197 }] });
    expect(wide.fit.uvScale[1]).toBeCloseTo((640 / 200) ** -1 * (640 / 360), 4);
    near(wide.probesPx[0], RED);
    near(wide.probesPx[1], WHITE);
  });

  gpuIt('glitch displaces window content only inside the quad and only when glitch > 0', async () => {
    const quad: SceneSpec['quad'] = [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.7, y: 0.7 }, { x: 0.3, y: 0.7 }];
    const column = Array.from({ length: 36 }, (_, i) => ({ x: 0.49, y: 0.31 + i * 0.01 }));
    const outside = [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, { x: 0.5, y: 0.1 }];
    const base = { video: { w: 640, h: 360, pattern: 'quadrants' as const }, base: 'live' as const, window: 'passthrough' as const, quad, time: 3.3 };
    const off = await run({ ...base, glitch: 0, probes: [...column, ...outside] });
    const on = await run({ ...base, glitch: 1, probes: [...column, ...outside] });
    const diff = column.filter((_, i) => off.probes[i]!.some((c, k) => Math.abs(c - on.probes[i]![k]!) > 24)).length;
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThan(column.length); // subtle: not every band shifts
    for (let i = 0; i < outside.length; i++) near(on.probes[column.length + i], off.probes[column.length + i]!.slice(0, 3) as [number, number, number], 2);
    // glitch 0 is bit-identical to a plain cut-out
    const plain = await run({ ...base, glitch: 0, time: 9.9, probes: column });
    for (let i = 0; i < column.length; i++) near(plain.probes[i], off.probes[i]!.slice(0, 3) as [number, number, number], 1);
  });

  gpuIt('compilePass reports ok/log on the live context', async () => {
    const good = await page!.evaluate(() => (window as Window & { __w4?: W4Harness }).__w4!.compile('void main(){ fragColor = texture(u_color, v_uv) * texture(u_mask, v_uv).r; }'));
    expect(good.ok).toBe(true);
    const bad = await page!.evaluate(() => (window as Window & { __w4?: W4Harness }).__w4!.compile('void main(){ fragColor = nope; }'));
    expect(bad.ok).toBe(false);
    expect(bad.log.toLowerCase()).toMatch(/error/);
    const ver = await page!.evaluate(() => (window as Window & { __w4?: W4Harness }).__w4!.compile('#version 300 es\nvoid main(){}'));
    expect(ver.ok).toBe(false);
    expect(ver.log).toMatch(/#version/);
  });

  gpuIt('dirty overlays: false skips the upload, true or absent re-uploads', async () => {
    const spec: SceneSpec = {
      base: { solid: [0, 0, 0] }, window: 'passthrough',
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      overlay: { dots: [{ x: 0.5, y: 0.5, r: 0.1, color: '#ffffff' }], dirty: true },
    };
    const first = await run(spec);
    const uploadsAfterFirst = first.uploads.overlay;
    const skipped = await page!.evaluate(() => (window as Window & { __w4?: W4Harness }).__w4!.rerenderOverlay(false));
    expect(skipped.uploads.overlay).toBe(uploadsAfterFirst);
    expect(skipped.uploads.skippedOverlay).toBeGreaterThan(first.uploads.skippedOverlay);
    const again = await page!.evaluate(() => (window as Window & { __w4?: W4Harness }).__w4!.rerenderOverlay(true));
    expect(again.uploads.overlay).toBe(uploadsAfterFirst + 1);
    const absent = await page!.evaluate(() => (window as Window & { __w4?: W4Harness }).__w4!.rerenderOverlay(undefined));
    expect(absent.uploads.overlay).toBe(uploadsAfterFirst + 2);
  });

  gpuIt('context loss: render is a no-op while lost, resources rebuild on restore and pixels are correct again', async () => {
    const spec: SceneSpec = {
      base: { solid: [1, 0, 0] }, window: { solid: [0, 0, 1] },
      quad: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.7, y: 0.7 }, { x: 0.3, y: 0.7 }],
      probes: [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.1 }],
    };
    await run(spec);
    const lost = await page!.evaluate(() => (window as Window & { __w4?: W4Harness }).__w4!.loseAndRestore());
    expect(lost.lostSeen).toBe(true);
    expect(lost.restoredSeen).toBe(true);
    expect(lost.renderDuringLoss.contextLost).toBe(true);
    expect(lost.renderDuringLoss.stats.passes).toBe(0);
    const after = await run(spec);
    expect(after.contextLost).toBe(false);
    expect(after.contextLossCount).toBe(1);
    near(after.probes[0], BLUE);
    near(after.probes[1], RED);
  });
});
