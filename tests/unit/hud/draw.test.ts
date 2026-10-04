import { describe, it, expect, vi } from 'vitest';
import { drawHud, HUD_COLORS, HUD_FONT_STACK } from '../../../src/hud/draw';
import { buildHudModel } from '../../../src/hud/model';
import type { HudModelExt } from '../../../src/hud/model';
import { CAP_HEIGHT_EM } from '../../../src/hud/layout';
import type { HudCountdown, HudModel, SceneState } from '../../../src/types';
import { createFakeContext, ops, type Call } from './fakeContext';
import { makeFace, makeFrame, makeQuad, LIVE_SCENE, COMIC_SCENE, NO_EXTRAS } from './fixtures';

const SIZE = { width: 1920, height: 1080 };
const OPTS = { reducedMotion: false };

function sampleModel(scene = LIVE_SCENE, t = 0): HudModelExt {
  return buildHudModel(makeFrame({ face: makeFace() }), makeQuad({ area: 0.2 }), scene, t, NO_EXTRAS);
}

/** Countdown model with no quad at all (window hidden). */
function countdownModel(countdown: HudCountdown, scene: SceneState = LIVE_SCENE, t = 0): HudModelExt {
  return buildHudModel(null, null, scene, t, { ...NO_EXTRAS, countdown });
}

/** fillText calls drawn with a 300-weight font of exactly `px` pixels. */
const withFont = (calls: Call[], px: number) => ops(calls, 'fillText').filter((c) => String(c.state['font']).startsWith(`300 ${px}px `));

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

describe('drawHud — countdown', () => {
  // 18 % of 1080 = 194.4 → 194 px numeral; regular HUD label size at 1080p is 20 px.
  const NUMERAL_PX = 194;
  const BASELINE_Y = Math.round(540 + (NUMERAL_PX * CAP_HEIGHT_EM) / 2);
  const CAP_TOP_Y = BASELINE_Y - NUMERAL_PX * CAP_HEIGHT_EM;

  it('draws the numeral centred, weight 300 at 18 % of canvas height, tint colour, alpha 0.9, shadow — with no quad at all', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, countdownModel({ action: 'record', secondsLeft: 3, progress: 0 }), SIZE, OPTS);
    const numeral = withFont(calls, NUMERAL_PX);
    expect(numeral).toHaveLength(1);
    const g = numeral[0]!;
    expect(g.args[0]).toBe('3');
    expect(Number(g.args[1])).toBe(960 - 5);        // one 10 px glyph centred on x = 960
    expect(Number(g.args[2])).toBe(BASELINE_Y);     // cap height centred on y = 540
    expect(g.state['fillStyle']).toBe('#f5f5f7');
    expect(g.state['globalAlpha']).toBeCloseTo(0.9);
    expect(g.state['shadowBlur']).toBe(2);
    expect(g.state['shadowColor']).toBe('rgba(0,0,0,.35)');
    expect(g.state['textBaseline']).toBe('alphabetic');
    expect(String(g.state['font'])).toContain('Inter');
  });

  it('tracks a two-digit numeral glyph by glyph and centres the whole string', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, countdownModel({ action: 'record', secondsLeft: 10, progress: 0 }), SIZE, OPTS);
    const numeral = withFont(calls, NUMERAL_PX);
    expect(numeral.map((g) => g.args[0]).join('')).toBe('10');
    const xs = numeral.map((g) => Number(g.args[1]));
    const tracking = NUMERAL_PX * 0.04;
    expect(xs[1]! - xs[0]!).toBeCloseTo(10 + tracking, 5);
    expect(xs[0]! + (20 + tracking) / 2).toBeCloseTo(960, 5);
  });

  it('writes "RECORDING IN" above the numeral at the regular HUD size, centred, in the tint colour', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, countdownModel({ action: 'record', secondsLeft: 3, progress: 0 }, COMIC_SCENE), SIZE, OPTS);
    const label = withFont(calls, 20);
    expect(label.map((g) => g.args[0]).join('')).toBe('RECORDING IN');
    expect(Number(label[0]!.args[2])).toBeLessThan(CAP_TOP_Y);
    const xs = label.map((g) => Number(g.args[1]));
    expect((xs[0]! + xs[xs.length - 1]! + 10) / 2).toBeCloseTo(960, 5);
    expect(label[0]!.state['fillStyle']).toBe('#ff2b2b');
    expect(label[0]!.state['globalAlpha']).toBeCloseTo(0.9);
    expect(withFont(calls, NUMERAL_PX)[0]!.state['fillStyle']).toBe('#ff2b2b');
  });

  it('writes "SNAPSHOT IN" for snapshot countdowns', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, countdownModel({ action: 'snapshot', secondsLeft: 5, progress: 0.5 }), SIZE, OPTS);
    expect(withFont(calls, 20).map((g) => g.args[0]).join('')).toBe('SNAPSHOT IN');
    expect(withFont(calls, NUMERAL_PX).map((g) => g.args[0]).join('')).toBe('5');
  });

  it('draws a thin progress arc around the numeral from 12 o\'clock (0.25 → quarter turn); none at 0', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, countdownModel({ action: 'record', secondsLeft: 3, progress: 0.25 }), SIZE, OPTS);
    const arcs = ops(calls, 'arc');
    expect(arcs).toHaveLength(1);
    const [cx, cy, r, a0, a1] = arcs[0]!.args.map(Number) as [number, number, number, number, number];
    expect(cx).toBe(960);
    expect(cy).toBe(540);
    expect(r).toBeGreaterThan(NUMERAL_PX * 0.65);
    expect(a0).toBeCloseTo(-Math.PI / 2, 9);
    expect(a1).toBeCloseTo(0, 9);
    expect(arcs[0]!.state['lineWidth']).toBe(1.5);
    expect(arcs[0]!.state['strokeStyle']).toBe('#f5f5f7');
    expect(arcs[0]!.state['globalAlpha']).toBeCloseTo(0.9);
    expect(calls[calls.indexOf(arcs[0]!) + 1]?.op).toBe('stroke');
    const zero = createFakeContext(10);
    drawHud(zero.ctx, countdownModel({ action: 'record', secondsLeft: 3, progress: 0 }), SIZE, OPTS);
    expect(ops(zero.calls, 'arc')).toEqual([]);
  });

  it('never shrinks the numeral below 48 px', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, countdownModel({ action: 'record', secondsLeft: 3, progress: 0 }), { width: 320, height: 200 }, OPTS);
    expect(withFont(calls, 48)).toHaveLength(1);
  });

  it('is static: identical draw calls across time and reduced-motion settings (no pulse)', () => {
    const a = createFakeContext(10);
    drawHud(a.ctx, countdownModel({ action: 'record', secondsLeft: 2, progress: 0.4 }, LIVE_SCENE, 100), SIZE, { reducedMotion: false });
    const b = createFakeContext(10);
    drawHud(b.ctx, countdownModel({ action: 'record', secondsLeft: 2, progress: 0.4 }, LIVE_SCENE, 733), SIZE, { reducedMotion: true });
    expect(withFont(a.calls, NUMERAL_PX).map((g) => g.args[0]).join('')).toBe('2');
    expect(a.calls).toEqual(b.calls);
  });

  it('ignores the window opacity: drawn while the window is faded out, when the callouts are not', () => {
    const { ctx, calls } = createFakeContext(10);
    const m = buildHudModel(null, makeQuad({ opacity: 0 }), LIVE_SCENE, 0, { ...NO_EXTRAS, countdown: { action: 'snapshot', secondsLeft: 1, progress: 0.9 } });
    expect(m.callouts).toHaveLength(1);
    drawHud(ctx, m, SIZE, OPTS);
    expect(withFont(calls, NUMERAL_PX).map((g) => g.args[0]).join('')).toBe('1');
    expect(ops(calls, 'lineTo')).toEqual([]); // no bracket → callouts skipped
  });

  it('skips a countdown whose secondsLeft is not finite', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, countdownModel({ action: 'record', secondsLeft: Number.NaN, progress: 0.2 }), SIZE, OPTS);
    expect(ops(calls, 'fillText')).toEqual([]);
    expect(ops(calls, 'arc')).toEqual([]);
  });

  it('leaves the default path untouched: null countdown/dwell draw exactly what the plain extras draw', () => {
    const frame = makeFrame({ face: makeFace({ mouthOpen: 0.8 }) });
    const a = createFakeContext(10);
    drawHud(a.ctx, buildHudModel(frame, makeQuad({ area: 0.2 }), LIVE_SCENE, 0, NO_EXTRAS), SIZE, OPTS);
    const b = createFakeContext(10);
    drawHud(b.ctx, buildHudModel(frame, makeQuad({ area: 0.2 }), LIVE_SCENE, 0, { ...NO_EXTRAS, countdown: null, dwellProgress: null }), SIZE, OPTS);
    expect(b.calls).toEqual(a.calls);
    expect(ops(a.calls, 'arc')).toEqual([]);
    expect(ops(a.calls, 'strokeRect')).toHaveLength(1); // the mouth box still comes through `boxes`
  });

  it('also renders a plain contract HudModel carrying countdown and boxes (no ext fields)', () => {
    const { ctx, calls } = createFakeContext(10);
    const m: HudModel = {
      tint: 'white', callouts: [], opacity: 1, recording: false, fps: null,
      boxes: [{ center: { x: 0.5, y: 0.5 }, w: 0.1, h: 0.05 }],
      countdown: { action: 'record', secondsLeft: 4, progress: 0 },
    };
    drawHud(ctx, m, SIZE, OPTS);
    const rect = ops(calls, 'strokeRect')[0]!;
    const [x, y, w, h] = rect.args.map(Number) as [number, number, number, number];
    expect(x + w / 2).toBeCloseTo(960, 3);
    expect(y + h / 2).toBeCloseTo(540, 3);
    expect(withFont(calls, NUMERAL_PX).map((g) => g.args[0]).join('')).toBe('4');
  });
});

describe('drawHud — dwell ring', () => {
  const dwellModel = (dwellProgress: number, quad = makeQuad()) =>
    buildHudModel(null, quad, LIVE_SCENE, 0, { ...NO_EXTRAS, dwellProgress });
  // Corner anchor of the fixture quad: (0.3, 0.25) → (576, 270) at 1080p.
  const CX = 0.3 * 1920; const CY = 0.25 * 1080;

  it('draws a 1.5 px quarter arc from 12 o\'clock around the corner anchor at progress 0.25 (radius 21 px at 1080p)', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, dwellModel(0.25), SIZE, OPTS);
    const arcs = ops(calls, 'arc');
    expect(arcs).toHaveLength(1);
    const [cx, cy, r, a0, a1] = arcs[0]!.args.map(Number) as [number, number, number, number, number];
    expect(cx).toBeCloseTo(CX, 5);
    expect(cy).toBeCloseTo(CY, 5);
    expect(r).toBe(21);
    expect(a0).toBeCloseTo(-Math.PI / 2, 9);
    expect(a1).toBeCloseTo(0, 9);
    expect(arcs[0]!.state['lineWidth']).toBe(1.5);
    expect(arcs[0]!.state['strokeStyle']).toBe('#f5f5f7');
    expect(arcs[0]!.state['shadowBlur']).toBe(2);
    expect(calls[calls.indexOf(arcs[0]!) + 1]?.op).toBe('stroke');
  });

  it('spans progress × 360°: 0.5 → half turn, 1 → full circle', () => {
    const half = createFakeContext(10);
    drawHud(half.ctx, dwellModel(0.5), SIZE, OPTS);
    expect(Number(ops(half.calls, 'arc')[0]!.args[4])).toBeCloseTo(Math.PI / 2, 9);
    const full = createFakeContext(10);
    drawHud(full.ctx, dwellModel(1), SIZE, OPTS);
    expect(Number(ops(full.calls, 'arc')[0]!.args[4])).toBeCloseTo(-Math.PI / 2 + Math.PI * 2, 9);
  });

  it('scales the radius with the canvas height: 14 px at 720p, 7 px at 360p', () => {
    const a = createFakeContext(10);
    drawHud(a.ctx, dwellModel(0.5), { width: 1280, height: 720 }, OPTS);
    expect(Number(ops(a.calls, 'arc')[0]!.args[2])).toBe(14);
    const b = createFakeContext(10);
    drawHud(b.ctx, dwellModel(0.5), { width: 640, height: 360 }, OPTS);
    expect(Number(ops(b.calls, 'arc')[0]!.args[2])).toBe(7);
  });

  it('follows the model opacity and uses the tint colour', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, buildHudModel(null, makeQuad({ opacity: 0.5 }), COMIC_SCENE, 0, { ...NO_EXTRAS, dwellProgress: 0.5 }), SIZE, OPTS);
    const arc = ops(calls, 'arc')[0]!;
    expect(arc.state['globalAlpha']).toBeCloseTo(0.5);
    expect(arc.state['strokeStyle']).toBe('#ff2b2b');
  });

  it('is not drawn at progress 0, when the window is faded out or hidden, or without a corner callout', () => {
    const zero = createFakeContext(10);
    drawHud(zero.ctx, dwellModel(0), SIZE, OPTS);
    expect(ops(zero.calls, 'arc')).toEqual([]);
    const faded = createFakeContext(10);
    drawHud(faded.ctx, dwellModel(0.5, makeQuad({ opacity: 0 })), SIZE, OPTS);
    expect(ops(faded.calls, 'arc')).toEqual([]);
    const hidden = createFakeContext(10);
    drawHud(hidden.ctx, dwellModel(0.5, makeQuad({ visible: false })), SIZE, OPTS);
    expect(ops(hidden.calls, 'arc')).toEqual([]);
    const noCorner = createFakeContext(10);
    const m: HudModel = {
      tint: 'white', opacity: 1, recording: false, fps: null, dwellProgress: 0.5,
      callouts: [{ id: 'eye-left', anchor: { x: 0.45, y: 0.4 }, code: '1610301', bracket: true }],
    };
    drawHud(noCorner.ctx, m, SIZE, OPTS);
    expect(ops(noCorner.calls, 'arc')).toEqual([]);
  });

  it('is drawn after the callouts without disturbing their 1 px strokes', () => {
    const { ctx, calls } = createFakeContext(10);
    drawHud(ctx, buildHudModel(makeFrame({ face: makeFace() }), makeQuad(), LIVE_SCENE, 0, { ...NO_EXTRAS, dwellProgress: 0.5 }), SIZE, OPTS);
    const arcList = ops(calls, 'arc');
    expect(arcList).toHaveLength(1);
    const arcIndex = calls.indexOf(arcList[0]!);
    const before = calls.slice(0, arcIndex).filter((c) => c.op === 'stroke');
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((s) => s.state['lineWidth'] === 1)).toBe(true);
    expect(calls.slice(arcIndex).some((c) => c.op === 'fillText')).toBe(false);
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
