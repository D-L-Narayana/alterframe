import { describe, it, expect, vi } from 'vitest';
import { drawHud, HUD_COLORS, HUD_FONT_STACK } from '../../../src/hud/draw';
import { buildHudModel } from '../../../src/hud/model';
import type { HudModelExt } from '../../../src/hud/model';
import { createFakeContext, ops } from './fakeContext';
import { makeFace, makeFrame, makeQuad, LIVE_SCENE, COMIC_SCENE, NO_EXTRAS } from './fixtures';

const SIZE = { width: 1920, height: 1080 };
const OPTS = { reducedMotion: false };

function sampleModel(scene = LIVE_SCENE, t = 0): HudModelExt {
  return buildHudModel(makeFrame({ face: makeFace() }), makeQuad({ area: 0.2 }), scene, t, NO_EXTRAS);
}

describe('drawHud — basics', () => {
  it('clears the whole canvas first', () => {
    const { ctx, calls } = createFakeContext();
    drawHud(ctx, sampleModel(), SIZE, OPTS);
    expect(calls[0]).toMatchObject({ op: 'clearRect', args: [0, 0, 1920, 1080] });
  });

  it('draws nothing but the clear for an empty model', () => {
    const { ctx, calls } = createFakeContext();
    drawHud(ctx, buildHudModel(null, null, LIVE_SCENE, 0, NO_EXTRAS), SIZE, OPTS);
    expect(calls.filter((c) => !['clearRect', 'save', 'restore'].includes(c.op))).toEqual([]);
  });

  it('skips callouts entirely when opacity is 0', () => {
    const { ctx, calls } = createFakeContext();
    const m = { ...sampleModel(), opacity: 0 };
    drawHud(ctx, m, SIZE, OPTS);
    expect(ops(calls, 'fillText')).toEqual([]);
  });
});

describe('drawHud — typography', () => {
  it('uses a 300-weight Inter font sized at 1.85 % of height with a system fallback', () => {
    const { ctx, calls } = createFakeContext();
    drawHud(ctx, sampleModel(), SIZE, OPTS);
    const font = ops(calls, 'fillText')[0]?.state['font'] as string;
    expect(font.startsWith('300 20px ')).toBe(true);
    expect(font).toContain('Inter');
    expect(font).toContain('system-ui');
    expect(HUD_FONT_STACK).toContain('sans-serif');
  });

  it('renders every code glyph by glyph with manual tracking (left-aligned, increasing x)', () => {
    const { ctx, calls } = createFakeContext(10);
    const m = buildHudModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS); // corner only, anchor x = 0.3
    drawHud(ctx, m, SIZE, OPTS);
    const glyphs = ops(calls, 'fillText');
    expect(glyphs).toHaveLength(7);
    expect(glyphs.map((g) => g.args[0]).join('')).toBe(m.callouts[0]?.code);
    const xs = glyphs.map((g) => Number(g.args[1]));
    expect(xs[0]).toBe(Math.round(0.3 * 1920));
    // tracking = 0.04 em of 20 px = 0.8 px per gap → advance 10.8
    expect(xs[1]! - xs[0]!).toBeCloseTo(10.8, 5);
    // baseline 6 px above anchor (y = 0.25 * 1080 = 270)
    expect(Number(glyphs[0]?.args[2])).toBe(264);
  });

  it('right-aligns labels for anchors past x = 0.7 so the last glyph ends at the anchor', () => {
    const { ctx, calls } = createFakeContext(10);
    const quad = makeQuad({ corners: [{ x: 0.9, y: 0.5 }, { x: 0.95, y: 0.5 }, { x: 0.95, y: 0.8 }, { x: 0.9, y: 0.8 }] });
    const m = buildHudModel(null, quad, LIVE_SCENE, 0, NO_EXTRAS);
    drawHud(ctx, m, SIZE, OPTS);
    const glyphs = ops(calls, 'fillText');
    const last = glyphs[glyphs.length - 1]!;
    expect(Number(last.args[1]) + 10).toBeCloseTo(Math.round(0.9 * 1920), 5);
    expect(Number(glyphs[0]?.args[1])).toBeLessThan(Number(last.args[1]));
  });
});

describe('drawHud — tint and alpha', () => {
  it('fills white #f5f5f7 on the live base and red #ff2b2b on comic', () => {
    expect(HUD_COLORS.white).toBe('#f5f5f7');
    expect(HUD_COLORS.red).toBe('#ff2b2b');
    const a = createFakeContext();
    drawHud(a.ctx, sampleModel(LIVE_SCENE), SIZE, OPTS);
    expect(ops(a.calls, 'fillText')[0]?.state['fillStyle']).toBe('#f5f5f7');
    const b = createFakeContext();
    drawHud(b.ctx, sampleModel(COMIC_SCENE), SIZE, OPTS);
    expect(ops(b.calls, 'fillText')[0]?.state['fillStyle']).toBe('#ff2b2b');
    expect(ops(b.calls, 'stroke')[0]?.state['strokeStyle']).toBe('#ff2b2b');
  });

  it('applies model.opacity as globalAlpha to callouts', () => {
    const { ctx, calls } = createFakeContext();
    drawHud(ctx, { ...sampleModel(), opacity: 0.5 }, SIZE, OPTS);
    expect(ops(calls, 'fillText')[0]?.state['globalAlpha']).toBeCloseTo(0.5);
  });

  it('uses a 1 px line with a 2 px soft shadow for leaders', () => {
    const { ctx, calls } = createFakeContext();
    drawHud(ctx, sampleModel(), SIZE, OPTS);
    const stroke = ops(calls, 'stroke')[0]!;
    expect(stroke.state['lineWidth']).toBe(1);
    expect(stroke.state['shadowBlur']).toBe(2);
    expect(stroke.state['shadowColor']).toBe('rgba(0,0,0,.35)');
  });
});

describe('drawHud — leaders, brackets, boxes', () => {
  it('draws a leader line from the callout anchor to leaderTo in pixels', () => {
    const { ctx, calls } = createFakeContext();
    const m = sampleModel();
    drawHud(ctx, m, SIZE, OPTS);
    const eye = m.callouts.find((c) => c.id === 'eye-left')!;
    const ax = eye.anchor.x * 1920; const ay = eye.anchor.y * 1080;
    const lx = eye.leaderTo!.x * 1920; const ly = eye.leaderTo!.y * 1080;
    const near = (c: { args: number[] | string[] }, x: number, y: number) =>
      Math.abs(Number(c.args[0]) - x) < 1 && Math.abs(Number(c.args[1]) - y) < 1;
    // moveTo(anchor) immediately followed by lineTo(leaderTo)
    const found = calls.some((c, i) => c.op === 'moveTo' && near(c, ax, ay) && calls[i + 1]?.op === 'lineTo' && near(calls[i + 1]!, lx, ly));
    expect(found).toBe(true);
  });

  it('draws a 6 px L bracket at each bracketed anchor', () => {
    const { ctx, calls } = createFakeContext();
    const m = buildHudModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    drawHud(ctx, m, SIZE, OPTS);
    const ax = Math.round(0.3 * 1920) + 0.5; const ay = Math.round(0.25 * 1080) + 0.5; // crisp 1 px alignment
    const lines = ops(calls, 'lineTo').map((l) => l.args.map(Number));
    expect(lines).toContainEqual([ax + 6, ay]);
    expect(lines).toContainEqual([ax, ay + 6]);
  });

  it('draws the mouth box as a thin rectangle centred at its anchor', () => {
    const { ctx, calls } = createFakeContext();
    const m = buildHudModel(makeFrame({ face: makeFace({ mouthOpen: 0.8 }) }), makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    drawHud(ctx, m, SIZE, OPTS);
    const box = m.boxes[0]!;
    const r = ops(calls, 'strokeRect')[0]!;
    const [x, y, w, h] = r.args.map(Number) as [number, number, number, number];
    expect(w).toBeCloseTo(box.w * 1920, 3);
    expect(h).toBeCloseTo(box.h * 1080, 3);
    expect(x + w / 2).toBeCloseTo(box.center.x * 1920, 3);
    expect(y + h / 2).toBeCloseTo(box.center.y * 1080, 3);
    expect(r.state['lineWidth']).toBe(1);
  });

  it('also honours a contract-level callout.box (rectangle centred at the callout anchor)', () => {
    const { ctx, calls } = createFakeContext();
    const m = buildHudModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    m.callouts[0]!.box = { w: 0.1, h: 0.05 };
    drawHud(ctx, m, SIZE, OPTS);
    const r = ops(calls, 'strokeRect')[0]!;
    const [x, y, w, h] = r.args.map(Number) as [number, number, number, number];
    expect(x + w / 2).toBeCloseTo(0.3 * 1920, 3);
    expect(y + h / 2).toBeCloseTo(0.25 * 1080, 3);
  });
});

describe('drawHud — record dot and fps badge', () => {
  const rec = (t: number) => ({ ...buildHudModel(null, null, LIVE_SCENE, t, { recording: true, fps: null, showFps: false }) });

  it('draws a 10 px red dot in the top-right corner while recording', () => {
    const { ctx, calls } = createFakeContext();
    drawHud(ctx, rec(0), SIZE, OPTS);
    const arc = ops(calls, 'arc')[0]!;
    const [cx, cy, r] = arc.args.map(Number) as [number, number, number];
    expect(r).toBe(5);
    expect(cx).toBeGreaterThan(1920 - 40);
    expect(cy).toBeLessThan(40);
    expect(arc.state['fillStyle']).toBe('#ff2b2b');
    // the dot ignores window opacity
    expect(arc.state['globalAlpha']).toBe(1);
  });

  it('blinks at 1 Hz (off during the second half-second)', () => {
    const on = createFakeContext();
    drawHud(on.ctx, rec(200), SIZE, OPTS);
    expect(ops(on.calls, 'arc')).toHaveLength(1);
    const off = createFakeContext();
    drawHud(off.ctx, rec(700), SIZE, OPTS);
    expect(ops(off.calls, 'arc')).toHaveLength(0);
  });

  it('stays solid under reduced motion', () => {
    const { ctx, calls } = createFakeContext();
    drawHud(ctx, rec(700), SIZE, { reducedMotion: true });
    expect(ops(calls, 'arc')).toHaveLength(1);
  });

  it('draws the fps badge top-left when fps is set', () => {
    const { ctx, calls } = createFakeContext();
    drawHud(ctx, buildHudModel(null, null, LIVE_SCENE, 0, { recording: false, fps: 59.6, showFps: true }), SIZE, OPTS);
    const texts = ops(calls, 'fillText');
    expect(texts.map((t) => t.args[0]).join('')).toBe('60 fps');
    expect(Number(texts[0]?.args[1])).toBeLessThan(40);
    expect(Number(texts[0]?.args[2])).toBeLessThan(40);
  });
});

describe('drawHud — debug landmarks', () => {
  it('calls the injected debugDraw after the HUD when enabled and a frame exists', () => {
    const { ctx, calls } = createFakeContext();
    const frame = makeFrame({ face: makeFace() });
    const m = buildHudModel(frame, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    const debugDraw = vi.fn(() => { ctx.fillRect(0, 0, 1, 1); });
    drawHud(ctx, m, SIZE, { reducedMotion: false, debugLandmarks: true, debugDraw });
    expect(debugDraw).toHaveBeenCalledWith(ctx, frame, SIZE);
    const lastText = calls.lastIndexOf(ops(calls, 'fillText').at(-1)!);
    expect(calls.findIndex((c) => c.op === 'fillRect')).toBeGreaterThan(lastText);
  });

  it('does not call debugDraw when disabled or without a frame', () => {
    const { ctx } = createFakeContext();
    const debugDraw = vi.fn();
    drawHud(ctx, buildHudModel(makeFrame(), makeQuad(), LIVE_SCENE, 0, NO_EXTRAS), SIZE, { reducedMotion: false, debugLandmarks: false, debugDraw });
    drawHud(ctx, buildHudModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS), SIZE, { reducedMotion: false, debugLandmarks: true, debugDraw });
    expect(debugDraw).not.toHaveBeenCalled();
  });
});
