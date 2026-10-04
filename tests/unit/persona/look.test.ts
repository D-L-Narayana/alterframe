import { describe, it, expect } from 'vitest';
import { createPersonaLayer } from '../../../src/render/persona';
import { lensShape, lensPoints, lensSquash, smoothstep, polygonBounds, rotateAbout } from '../../../src/render/persona/geometry';
import { drawMaskedOverlay } from '../../../src/render/persona/faceOverlay';
import { cityParallaxOffset, cityLayerOffset, drawCityBackdrop, parallaxOffset, HEAD_PARALLAX, SKYLINE } from '../../../src/render/persona/backdrops';
import { overlaySignature, backdropSignature } from '../../../src/render/persona/signature';
import { DEFAULT_LOOK, type LookSettings, type PersonaId, type SceneState } from '../../../src/types';
import { makeFace, makeFrame } from './fixtures';
import { recordingCanvasFactory, setsOf, callsNamed, entriesAfterCall, type RecordedEntry } from './recorder';

/*
 * v0.2 persona behaviour: look-aware overlay alpha, masked lens squint, night-city head parallax.
 * Environment: Node (vitest) with the recording 2D context — sequences, not pixels.
 */

const SIZE = { width: 640, height: 360 };
const scene = (persona: PersonaId): SceneState => ({ base: 'live', persona, hudTint: 'white' });
const look = (overlayStrength: number): LookSettings => ({ ...DEFAULT_LOOK, overlayStrength });
const DRAW_CALLS = ['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText'];
const drawCalls = (log: readonly RecordedEntry[]) => log.filter((e) => e.kind === 'call' && DRAW_CALLS.includes(e.name));

function paintOverlay(persona: PersonaId, l?: LookSettings, eyeOpen = 1) {
  const rec = recordingCanvasFactory();
  const layer = createPersonaLayer({ createCanvas: rec.factory, reducedMotion: false, seed: 5 });
  layer.resize(SIZE);
  const frame = makeFrame(makeFace({ cx: 0.5, eyeOpen }));
  if (l) layer.update(frame, scene(persona), 0, l); else layer.update(frame, scene(persona), 0);
  return { layer, rec, overlay: rec.logOf(layer.overlay), backdrop: rec.logOf(layer.backdrop) };
}

/** globalAlpha assignments made while painting overlay ELEMENTS (after the clear; the reset to 1 before clearRect is excluded). */
const elementAlphas = (overlay: readonly RecordedEntry[]) => setsOf(entriesAfterCall(overlay, 'clearRect'), 'globalAlpha') as number[];

describe('overlayStrength scales every overlay alpha through globalAlpha', () => {
  for (const persona of ['portrait', 'masked', 'suit'] as const) {
    it(`${persona}: strength 0.5 halves every globalAlpha set of the default run and changes nothing else`, () => {
      const full = paintOverlay(persona).overlay;
      const half = paintOverlay(persona, look(0.5)).overlay;
      const a1 = elementAlphas(full), a05 = elementAlphas(half);
      expect(a1.length).toBeGreaterThan(0);
      expect(a05).toEqual(a1.map((v) => v * 0.5));
      // same operations in the same order, only the alpha values differ
      expect(half.length).toBe(full.length);
      const strip = (log: readonly RecordedEntry[]) => log.filter((e) => !(e.kind === 'set' && e.name === 'globalAlpha'));
      expect(strip(half)).toEqual(strip(full));
      // the clear itself is never attenuated
      expect(setsOf(half, 'globalAlpha')[0]).toBe(1);
      expect(callsNamed(half, 'clearRect')).toEqual([[0, 0, 640, 360]]);
    });

    it(`${persona}: strength 0 clears the overlay but draws nothing; the backdrop is still painted; face motion no longer repaints`, () => {
      const { overlay, backdrop, layer, rec } = paintOverlay(persona, look(0));
      expect(callsNamed(overlay, 'clearRect')).toEqual([[0, 0, 640, 360]]);
      expect(drawCalls(overlay)).toEqual([]);
      expect(elementAlphas(overlay)).toEqual([]);
      expect(drawCalls(backdrop).length).toBeGreaterThan(0);
      expect(layer.overlay.__dirty).toBe(true);
      // nothing to draw → the cleared canvas is left alone while the face moves
      const n = rec.logOf(layer.overlay).length;
      layer.update(makeFrame(makeFace({ cx: 0.4 })), scene(persona), 16, look(0));
      expect(rec.logOf(layer.overlay).length).toBe(n);
      // restoring the strength repaints
      layer.update(makeFrame(makeFace({ cx: 0.4 })), scene(persona), 32, look(1));
      expect(drawCalls(rec.logOf(layer.overlay)).length).toBeGreaterThan(0);
    });
  }

  it('no alpha ever exceeds the v0.1 value: strength clamps to [0, 1] (1.5 ≡ 1, -1 ≡ 0) and NaN falls back to 1', () => {
    const ref = paintOverlay('masked').overlay;
    expect(paintOverlay('masked', look(1.5)).overlay).toEqual(ref);
    expect(paintOverlay('masked', look(Number.NaN)).overlay).toEqual(ref);
    expect(drawCalls(paintOverlay('masked', look(-1)).overlay)).toEqual([]);
    for (const a of elementAlphas(paintOverlay('masked', look(0.73)).overlay)) expect(a).toBeLessThanOrEqual(0.9 + 1e-9);
  });

  it('other look fields (ink, halftone, bands…) do not influence the persona layer', () => {
    const ref = paintOverlay('suit').overlay;
    const exotic: LookSettings = { inkWidth: 2.5, inkThreshold: 0.4, halftone: 0, saturation: 2, bands: 3, grain: 0, overlayStrength: 1 };
    expect(paintOverlay('suit', exotic).overlay).toEqual(ref);
  });

  it('a strength change of ≥ 0.02 repaints the overlay; 0.005 does not; equal values never do', () => {
    const { layer, rec } = paintOverlay('portrait', look(0.5));
    const len = () => rec.logOf(layer.overlay).length;
    const frame = makeFrame(makeFace({ cx: 0.5 }));
    const n0 = len();
    layer.overlay.__dirty = false;
    layer.update(frame, scene('portrait'), 16, look(0.5));
    expect(len()).toBe(n0);
    expect(layer.overlay.__dirty).toBe(false);
    layer.update(frame, scene('portrait'), 32, look(0.505));
    expect(len()).toBe(n0);
    expect(layer.overlay.__dirty).toBe(false);
    layer.update(frame, scene('portrait'), 48, look(0.52));
    expect(len()).toBeGreaterThan(n0);
    expect(layer.overlay.__dirty).toBe(true);
  });
});

describe('signatures carry the new inputs (quantized)', () => {
  it('overlaySignature: strength quantized to 0.02; omitted strength ≡ 1; a face-less frame ignores it', () => {
    const frame = makeFrame(makeFace());
    const sig = (s?: number) => (s === undefined ? overlaySignature(frame, scene('masked'), SIZE, 0) : overlaySignature(frame, scene('masked'), SIZE, 0, s));
    expect(sig(0.5)).toBe(sig(0.505));
    expect(sig(0.5)).not.toBe(sig(0.52));
    expect(sig()).toBe(sig(1));
    expect(sig(0)).not.toBe(sig(1));
    expect(sig(0.01)).not.toBe(sig(0));   // a faint overlay is still drawn, so it is not the "nothing drawn" state
    expect(overlaySignature(makeFrame(null), scene('masked'), SIZE, 0, 0.3)).toBe(overlaySignature(makeFrame(null), scene('masked'), SIZE, 0, 1));
    // strength 0 ≡ no face: constant per persona/size, independent of the landmarks
    expect(sig(0)).toBe(overlaySignature(makeFrame(makeFace({ cx: 0.3 })), scene('masked'), SIZE, 0, 0));
    expect(sig(0)).toBe(overlaySignature(makeFrame(null), scene('masked'), SIZE, 0, 1));
  });

  it('backdropSignature: masked city includes face x (0.01 steps) unless reduced motion; paper backdrops ignore it; omitted ≡ centre', () => {
    const sig = (p: PersonaId, reduced: boolean, fx?: number | null) => (fx === undefined ? backdropSignature(scene(p), SIZE, 0, reduced) : backdropSignature(scene(p), SIZE, 0, reduced, fx));
    expect(sig('masked', false, 0.5)).not.toBe(sig('masked', false, 0.6));
    expect(sig('masked', false, 0.5)).toBe(sig('masked', false, 0.503));
    expect(sig('masked', false)).toBe(sig('masked', false, 0.5));
    expect(sig('masked', false, null)).toBe(sig('masked', false, 0.5));
    expect(sig('masked', true, 0.5)).toBe(sig('masked', true, 0.6));
    for (const p of ['portrait', 'suit'] as const) expect(sig(p, false, 0.5)).toBe(sig(p, false, 0.6));
  });
});

describe('masked lens squint', () => {
  const eye = { center: { x: 400, y: 250 }, width: 50 };

  it('smoothstep(0.15, 0.75, ·) is exactly 0 at/below 0.15, exactly 1 at/above 0.75 (so 0.95 → 1), 0.5 at the midpoint', () => {
    expect(smoothstep(0.15, 0.75, 0.15)).toBe(0);
    expect(smoothstep(0.15, 0.75, 0)).toBe(0);
    expect(smoothstep(0.15, 0.75, 0.75)).toBe(1);
    expect(smoothstep(0.15, 0.75, 0.95)).toBe(1);
    expect(smoothstep(0.15, 0.75, 1)).toBe(1);
    expect(smoothstep(0.15, 0.75, 0.45)).toBeCloseTo(0.5, 12);
  });

  it('lensSquash: 0.55 when closed, exactly 1 for openness ≥ 0.75 (0.95, 0.98, 1), monotonic in between', () => {
    expect(lensSquash(0)).toBeCloseTo(0.55, 12);
    expect(lensSquash(0.3)).toBeLessThan(1);
    expect(lensSquash(0.3)).toBeGreaterThan(0.55);
    expect(lensSquash(0.95)).toBe(1);
    expect(lensSquash(0.98)).toBe(1);
    expect(lensSquash(1)).toBe(1);
    let prev = -Infinity;
    for (let o = 0; o <= 1.0001; o += 0.05) { const v = lensSquash(o); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
  });

  it('squash < 1 shortens the lens across its long axis about the eye centre; the on-axis inner end stays put', () => {
    const open = lensShape(eye, 'left', 0, 1);
    const squint = lensShape(eye, 'left', 0, 1, 0.7);
    const bo = polygonBounds(lensPoints(open)), bs = polygonBounds(lensPoints(squint));
    expect(bs.h).toBeLessThan(bo.h);
    expect(bs.h).toBeGreaterThan(bo.h * 0.6);
    expect(squint.start).toEqual(open.start);
    expect(squint.center).toEqual(eye.center);
    // the right-eye lens squashes the same amount (mirror symmetry preserved)
    const eyeR = { center: { x: 600, y: 250 }, width: 50 };
    const R = polygonBounds(lensPoints(lensShape(eyeR, 'right', 0, 1, 0.7)));
    expect(R.h).toBeCloseTo(bs.h, 9);
  });

  it('squash 1 (openness ≥ 0.95) yields exactly today\'s points', () => {
    for (const side of ['left', 'right'] as const) {
      expect(lensShape(eye, side, 0.2, 1.12, 1)).toEqual(lensShape(eye, side, 0.2, 1.12));
      expect(lensShape(eye, side, 0.2, 1.12, lensSquash(0.98))).toEqual(lensShape(eye, side, 0.2, 1.12));
      expect(lensShape(eye, side, 0, 1, lensSquash(0.95))).toEqual(lensShape(eye, side, 0));
    }
  });

  it('squash is applied in the lens frame, so head roll still rotates the squinted lens rigidly about the eye centre', () => {
    const roll = 0.5;
    const flat = lensPoints(lensShape(eye, 'left', 0, 1, 0.7));
    const rolled = lensPoints(lensShape(eye, 'left', roll, 1, 0.7));
    flat.forEach((p, i) => {
      const r = rotateAbout(p, roll, eye.center);
      expect(rolled[i]!.x).toBeCloseTo(r.x, 6);
      expect(rolled[i]!.y).toBeCloseTo(r.y, 6);
    });
  });

  it('drawMaskedOverlay: eye openness 0.3 paints shorter lenses than 1.0 with the same landmarks; 0.98 paints identical lenses', () => {
    const lensYSpan = (log: readonly RecordedEntry[]) => {
      const ys = callsNamed(log, 'bezierCurveTo').flatMap((a) => [a[1], a[3], a[5]] as number[]);
      expect(ys.length).toBe(16 * 3); // 2 eyes × (outline + inner highlight) × 4 segments
      return Math.max(...ys) - Math.min(...ys);
    };
    const paint = (open: number) => {
      const rec = recordingCanvasFactory();
      const c = rec.factory(SIZE.width, SIZE.height);
      const face = makeFace({ cx: 0.5 });   // landmarks of a fully open eye…
      face.eyeOpenLeft = open; face.eyeOpenRight = open;   // …with only the openness scalar changed
      drawMaskedOverlay(c.getContext('2d')!, face, SIZE);
      return rec.logOf(c);
    };
    expect(lensYSpan(paint(0.3))).toBeLessThan(lensYSpan(paint(1)));
    expect(paint(0.98)).toEqual(paint(1));
  });
});

describe('night-city head parallax', () => {
  it('cityParallaxOffset: 0 at centre, for no face and under reduced motion; sign follows face x; far < streaks < near', () => {
    expect(cityParallaxOffset(0.5, 'near', false)).toBe(0);
    expect(cityParallaxOffset(null, 'near', false)).toBe(0);
    expect(cityParallaxOffset(0.75, 'near', true)).toBe(0);
    expect(cityParallaxOffset(0.75, 'near', false)).toBeCloseTo(0.25 * 0.04, 12);
    expect(cityParallaxOffset(0.25, 'near', false)).toBeCloseTo(-0.25 * 0.04, 12);
    expect(cityParallaxOffset(0.75, 'far', false)).toBeCloseTo(0.25 * 0.02, 12);
    expect(cityParallaxOffset(0.75, 'streaks', false)).toBeCloseTo(0.25 * 0.03, 12);
    expect(HEAD_PARALLAX).toEqual({ near: 0.04, far: 0.02, streaks: 0.03 });
    const near = Math.abs(cityParallaxOffset(0.2, 'near', false)), far = Math.abs(cityParallaxOffset(0.2, 'far', false)), st = Math.abs(cityParallaxOffset(0.2, 'streaks', false));
    expect(far).toBeLessThan(st);
    expect(st).toBeLessThan(near);
  });

  it('cityLayerOffset = time drift + head parallax, wrapped into [0,1); identical to parallaxOffset at the centre / with no face', () => {
    for (const t of [0, 1000, 123456]) {
      expect(cityLayerOffset(t, 'near', false, 0.5)).toBe(parallaxOffset(t, SKYLINE.near.speed, false));
      expect(cityLayerOffset(t, 'far', false, null)).toBe(parallaxOffset(t, SKYLINE.far.speed, false));
      expect(cityLayerOffset(t, 'near', true, 0.9)).toBe(0);
    }
    expect(cityLayerOffset(0, 'near', false, 0.75)).toBeCloseTo(0.01, 12);
    expect(cityLayerOffset(0, 'near', false, 0.25)).toBeCloseTo(0.99, 12);   // negative offsets wrap so the two-blit seam cover still works
    expect(cityLayerOffset(0, 'far', false, 0.75)).toBeCloseTo(0.005, 12);
    expect(cityLayerOffset(0, 'streaks', false, 0.75)).toBeCloseTo(0.0075, 12);
  });

  it('drawCityBackdrop: face x 0.5 ≡ omitted ≡ null; x 0.75 shifts the painting; reduced motion freezes it', () => {
    const paint = (reduced: boolean, faceX?: number | null) => {
      const rec = recordingCanvasFactory();
      const c = rec.factory(SIZE.width, SIZE.height);
      const ctx = c.getContext('2d')!;
      if (faceX === undefined) drawCityBackdrop(ctx, SIZE, 0, reduced, 5); else drawCityBackdrop(ctx, SIZE, 0, reduced, 5, faceX);
      return rec.logOf(c);
    };
    const centre = paint(false, 0.5);
    expect(centre.length).toBeGreaterThan(20);
    expect(paint(false)).toEqual(centre);
    expect(paint(false, null)).toEqual(centre);
    expect(paint(false, 0.75)).not.toEqual(centre);
    expect(paint(true, 0.75)).toEqual(paint(true, 0.5));
  });

  it('layer: moving the face repaints the masked backdrop only (not under reduced motion, not for paper backdrops); losing the face ≡ centre', () => {
    // read through a helper: TS keeps the `__dirty = false` narrowing across the update() call otherwise
    const isDirty = (c: { __dirty?: boolean }) => c.__dirty === true;
    const run = (persona: PersonaId, reducedMotion: boolean) => {
      const rec = recordingCanvasFactory();
      const layer = createPersonaLayer({ createCanvas: rec.factory, reducedMotion, seed: 5 });
      layer.resize(SIZE);
      layer.update(makeFrame(makeFace({ cx: 0.5 })), scene(persona), 0);
      const n0 = rec.logOf(layer.backdrop).length;
      layer.backdrop.__dirty = false;
      layer.update(makeFrame(makeFace({ cx: 0.3 })), scene(persona), 10);   // same 33 ms tick
      const repainted = rec.logOf(layer.backdrop).length > n0 && isDirty(layer.backdrop);
      const n1 = rec.logOf(layer.backdrop).length;
      layer.backdrop.__dirty = false;
      layer.update(makeFrame(makeFace({ cx: 0.5 })), scene(persona), 20);
      layer.backdrop.__dirty = false;
      const n2 = rec.logOf(layer.backdrop).length;
      layer.update(makeFrame(null), scene(persona), 30);   // face lost → parallax 0 ≡ centre → no repaint
      const lostRepaints = rec.logOf(layer.backdrop).length > n2;
      return { repainted, movedBack: n2 > n1, lostRepaints };
    };
    expect(run('masked', false)).toEqual({ repainted: true, movedBack: true, lostRepaints: false });
    expect(run('masked', true)).toEqual({ repainted: false, movedBack: false, lostRepaints: false });
    expect(run('portrait', false)).toEqual({ repainted: false, movedBack: false, lostRepaints: false });
    expect(run('suit', false)).toEqual({ repainted: false, movedBack: false, lostRepaints: false });
  });
});
