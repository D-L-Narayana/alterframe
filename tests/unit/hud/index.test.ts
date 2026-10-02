import { describe, it, expect, vi } from 'vitest';
import { createHud } from '../../../src/hud';
import type { HudCanvasLike } from '../../../src/hud';
import { createFakeContext } from './fakeContext';
import { makeFace, makeFrame, makeQuad, LIVE_SCENE, NO_EXTRAS } from './fixtures';

function fakeCanvas() {
  const { ctx, calls } = createFakeContext();
  const canvas: HudCanvasLike = { width: 0, height: 0, getContext: vi.fn(() => ctx) };
  return { canvas, calls, ctx };
}

describe('createHud', () => {
  it('owns a canvas and sizes it on resize', () => {
    const { canvas } = fakeCanvas();
    const hud = createHud({ createCanvas: () => canvas });
    expect(hud.canvas).toBe(canvas);
    hud.resize({ width: 1280, height: 720 });
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
  });

  it('ignores non-positive or non-finite sizes', () => {
    const { canvas } = fakeCanvas();
    const hud = createHud({ createCanvas: () => canvas });
    hud.resize({ width: 1280, height: 720 });
    hud.resize({ width: 0, height: 720 });
    hud.resize({ width: Number.NaN, height: 10 });
    expect(canvas.width).toBe(1280);
  });

  it('buildModel is the pure builder (same output for same inputs)', () => {
    const hud = createHud({ createCanvas: () => fakeCanvas().canvas });
    const frame = makeFrame({ face: makeFace() });
    const a = hud.buildModel(frame, makeQuad(), LIVE_SCENE, 1000, NO_EXTRAS);
    const b = hud.buildModel(frame, makeQuad(), LIVE_SCENE, 1000, NO_EXTRAS);
    expect(a).toEqual(b);
    expect(a.callouts.map((c) => c.id)).toEqual(['corner', 'eye-left', 'eye-right']);
  });

  it('draws into its own canvas and marks it dirty', () => {
    const { canvas, calls } = fakeCanvas();
    const hud = createHud({ createCanvas: () => canvas });
    hud.resize({ width: 1920, height: 1080 });
    hud.draw(hud.buildModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS));
    expect(calls.some((c) => c.op === 'fillText')).toBe(true);
    expect((canvas as { __dirty?: boolean }).__dirty).toBe(true);
  });

  it('skips redrawing an identical model and clears the dirty flag', () => {
    const { canvas, calls } = fakeCanvas();
    const hud = createHud({ createCanvas: () => canvas });
    hud.resize({ width: 1920, height: 1080 });
    const m = hud.buildModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    hud.draw(m);
    const n = calls.length;
    hud.draw(m);
    expect(calls.length).toBe(n);
    expect((canvas as { __dirty?: boolean }).__dirty).toBe(false);
  });

  it('redraws after a resize even if the model is unchanged', () => {
    const { canvas, calls } = fakeCanvas();
    const hud = createHud({ createCanvas: () => canvas });
    hud.resize({ width: 1920, height: 1080 });
    const m = hud.buildModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    hud.draw(m);
    const n = calls.length;
    hud.resize({ width: 1280, height: 720 });
    hud.draw(m);
    expect(calls.length).toBeGreaterThan(n);
  });

  it('redraws when the blink phase changes while recording (and not under reduced motion)', () => {
    const { canvas, calls } = fakeCanvas();
    const hud = createHud({ createCanvas: () => canvas, reducedMotion: false });
    hud.resize({ width: 1920, height: 1080 });
    hud.draw(hud.buildModel(null, null, LIVE_SCENE, 100, { recording: true, fps: null, showFps: false }));
    const n = calls.length;
    hud.draw(hud.buildModel(null, null, LIVE_SCENE, 200, { recording: true, fps: null, showFps: false }));
    expect(calls.length).toBe(n); // same half-second → same frame
    hud.draw(hud.buildModel(null, null, LIVE_SCENE, 600, { recording: true, fps: null, showFps: false }));
    expect(calls.length).toBeGreaterThan(n);
  });

  it('does not redraw for blink phase under reduced motion', () => {
    const { canvas, calls } = fakeCanvas();
    const hud = createHud({ createCanvas: () => canvas, reducedMotion: true });
    hud.resize({ width: 1920, height: 1080 });
    hud.draw(hud.buildModel(null, null, LIVE_SCENE, 100, { recording: true, fps: null, showFps: false }));
    const n = calls.length;
    hud.draw(hud.buildModel(null, null, LIVE_SCENE, 600, { recording: true, fps: null, showFps: false }));
    expect(calls.length).toBe(n);
  });

  it('passes debugLandmarks + injected debugDraw through setOptions', () => {
    const { canvas } = fakeCanvas();
    const debugDraw = vi.fn();
    const hud = createHud({ createCanvas: () => canvas, debugDraw });
    hud.resize({ width: 1920, height: 1080 });
    const frame = makeFrame({ face: makeFace() });
    hud.draw(hud.buildModel(frame, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS));
    expect(debugDraw).not.toHaveBeenCalled();
    hud.setOptions({ debugLandmarks: true });
    hud.draw(hud.buildModel(frame, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS));
    expect(debugDraw).toHaveBeenCalledTimes(1);
  });

  it('draws nothing (and does not throw) before the first resize', () => {
    const { canvas, calls } = fakeCanvas();
    const hud = createHud({ createCanvas: () => canvas });
    expect(() => hud.draw(hud.buildModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS))).not.toThrow();
    expect(calls.some((c) => c.op === 'fillText')).toBe(false);
  });

  it('survives a canvas without a 2D context', () => {
    const canvas: HudCanvasLike = { width: 0, height: 0, getContext: () => null };
    const hud = createHud({ createCanvas: () => canvas });
    hud.resize({ width: 100, height: 100 });
    expect(() => hud.draw(hud.buildModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS))).not.toThrow();
  });
});

describe('createHud — font warm-up', () => {
  it('forces one redraw after the HUD font finishes loading', async () => {
    const { canvas, calls } = fakeCanvas();
    let resolveLoad: () => void = () => {};
    const fontsLoad = vi.fn(() => new Promise<void>((r) => { resolveLoad = r; }));
    const hud = createHud({ createCanvas: () => canvas, fonts: { load: fontsLoad } });
    expect(fontsLoad).toHaveBeenCalledWith(expect.stringContaining('Inter'));
    hud.resize({ width: 1920, height: 1080 });
    const m = hud.buildModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    hud.draw(m);
    const n = calls.length;
    hud.draw(m);
    expect(calls.length).toBe(n);
    resolveLoad();
    await Promise.resolve(); await Promise.resolve();
    hud.draw(m);
    expect(calls.length).toBeGreaterThan(n);
  });

  it('tolerates a rejected font load', async () => {
    const { canvas } = fakeCanvas();
    const hud = createHud({ createCanvas: () => canvas, fonts: { load: () => Promise.reject(new Error('no font')) } });
    await Promise.resolve(); await Promise.resolve();
    expect(hud.options.seed).toBe(0);
  });
});
