import { describe, it, expect } from 'vitest';
import { buildHudModel, EYE_RIGHT_MIN_AREA, MOUTH_OPEN_BOX_THRESHOLD, MOUTH_BOX_WIDTH_FACTOR } from '../../../src/hud/model';
import { makeFace, makeFrame, makeQuad, LIVE_SCENE, COMIC_SCENE, NO_EXTRAS } from './fixtures';

const byId = (m: ReturnType<typeof buildHudModel>, id: string) => m.callouts.find((c) => c.id === id);

describe('buildHudModel — visibility', () => {
  it('has no callouts when quad is null', () => {
    const m = buildHudModel(makeFrame({ face: makeFace() }), null, LIVE_SCENE, 0, NO_EXTRAS);
    expect(m.callouts).toEqual([]);
    expect(m.opacity).toBe(0);
  });

  it('has no callouts when quad is hidden', () => {
    const m = buildHudModel(makeFrame({ face: makeFace() }), makeQuad({ visible: false, opacity: 0 }), LIVE_SCENE, 0, NO_EXTRAS);
    expect(m.callouts).toEqual([]);
  });

  it('opacity follows quad opacity', () => {
    const m = buildHudModel(makeFrame(), makeQuad({ opacity: 0.42 }), LIVE_SCENE, 0, NO_EXTRAS);
    expect(m.opacity).toBeCloseTo(0.42);
  });

  it('still shows the corner callout when there is no tracking frame', () => {
    const m = buildHudModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    expect(m.callouts.map((c) => c.id)).toEqual(['corner']);
  });
});

describe('buildHudModel — corner callout', () => {
  it('anchors at corners[0] with code NN10100 and a bracket', () => {
    const quad = makeQuad();
    const m = buildHudModel(makeFrame(), quad, LIVE_SCENE, 0, NO_EXTRAS);
    const c = byId(m, 'corner');
    expect(c).toBeDefined();
    expect(c?.anchor).toEqual(quad.corners[0]);
    expect(c?.code).toMatch(/^[1-9][0-9]10100$/);
    expect(c?.bracket).toBe(true);
    expect(c?.leaderTo).toBeUndefined();
  });

  it('shares the same prefix across all callouts in a frame', () => {
    const m = buildHudModel(makeFrame({ face: makeFace() }), makeQuad({ area: 0.2 }), LIVE_SCENE, 5000, NO_EXTRAS);
    const prefixes = new Set(m.callouts.map((c) => c.code.slice(0, 2)));
    expect(prefixes.size).toBe(1);
  });

  it('re-rolls the prefix every 800 ms and keeps it stable within a slot', () => {
    const q = makeQuad();
    const a = byId(buildHudModel(makeFrame(), q, LIVE_SCENE, 0, NO_EXTRAS), 'corner')?.code;
    const b = byId(buildHudModel(makeFrame(), q, LIVE_SCENE, 700, NO_EXTRAS), 'corner')?.code;
    expect(a).toBe(b);
    const slots = new Set<string>();
    for (let i = 0; i < 10; i++) slots.add(byId(buildHudModel(makeFrame(), q, LIVE_SCENE, i * 800, NO_EXTRAS), 'corner')?.code ?? '');
    expect(slots.size).toBeGreaterThan(3);
  });
});

describe('buildHudModel — eye callouts', () => {
  it('adds eye-left with a leader from the corner anchor when a face is present', () => {
    const face = makeFace();
    const quad = makeQuad({ area: 0.03 });
    const m = buildHudModel(makeFrame({ face }), quad, LIVE_SCENE, 0, NO_EXTRAS);
    const e = byId(m, 'eye-left');
    expect(e?.anchor).toEqual(face.leftEye);
    expect(e?.code.endsWith('10301')).toBe(true);
    expect(e?.leaderTo).toEqual(quad.corners[0]);
    expect(byId(m, 'eye-right')).toBeUndefined();
  });

  it('adds eye-right (NN10502) only when the window is large (area > 0.06), chained from eye-left', () => {
    expect(EYE_RIGHT_MIN_AREA).toBe(0.06);
    const face = makeFace();
    const small = buildHudModel(makeFrame({ face }), makeQuad({ area: 0.06 }), LIVE_SCENE, 0, NO_EXTRAS);
    expect(byId(small, 'eye-right')).toBeUndefined();
    const big = buildHudModel(makeFrame({ face }), makeQuad({ area: 0.061 }), LIVE_SCENE, 0, NO_EXTRAS);
    const r = byId(big, 'eye-right');
    expect(r?.anchor).toEqual(face.rightEye);
    expect(r?.code.endsWith('10502')).toBe(true);
    expect(r?.leaderTo).toEqual(face.leftEye);
  });

  it('emits callouts in draw order corner, eye-left, eye-right', () => {
    const m = buildHudModel(makeFrame({ face: makeFace() }), makeQuad({ area: 0.2 }), LIVE_SCENE, 0, NO_EXTRAS);
    expect(m.callouts.map((c) => c.id)).toEqual(['corner', 'eye-left', 'eye-right']);
  });

  it('skips eye callouts when the face anchors are not finite', () => {
    const face = makeFace({ leftEye: { x: Number.NaN, y: 0.4 } });
    const m = buildHudModel(makeFrame({ face }), makeQuad({ area: 0.2 }), LIVE_SCENE, 0, NO_EXTRAS);
    expect(byId(m, 'eye-left')).toBeUndefined();
    // eye-right then chains from the corner instead of the missing eye-left.
    expect(byId(m, 'eye-right')?.leaderTo).toEqual(makeQuad().corners[0]);
  });
});

describe('buildHudModel — mouth box', () => {
  it('adds a thin box around the mouth on eye-left when mouthOpen > 0.35', () => {
    expect(MOUTH_OPEN_BOX_THRESHOLD).toBe(0.35);
    expect(MOUTH_BOX_WIDTH_FACTOR).toBe(1.6);
    const closed = buildHudModel(makeFrame({ face: makeFace({ mouthOpen: 0.35 }) }), makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    expect(closed.boxes).toEqual([]);
    expect(closed.callouts.some((c) => c.box)).toBe(false);

    const open = buildHudModel(makeFrame({ face: makeFace({ mouthOpen: 0.5 }) }), makeQuad(), LIVE_SCENE, 0, NO_EXTRAS);
    expect(open.boxes).toHaveLength(1);
    const box = open.boxes[0];
    // mouth width in fixture = 0.53 - 0.47 = 0.06 → box w = 0.096
    expect(box?.w).toBeCloseTo(0.096, 5);
    expect(box?.h).toBeGreaterThan(0);
    // centred on the mouth (mean of corners and lips)
    expect(box?.center.x).toBeCloseTo(0.5, 5);
    expect(box?.center.y).toBeCloseTo(0.5825, 3);
  });

  it('hides the mouth box when the quad is hidden', () => {
    const m = buildHudModel(makeFrame({ face: makeFace({ mouthOpen: 0.9 }) }), makeQuad({ visible: false }), LIVE_SCENE, 0, NO_EXTRAS);
    expect(m.boxes).toEqual([]);
  });
});

describe('buildHudModel — tint, recording, fps', () => {
  it('uses scene.hudTint', () => {
    expect(buildHudModel(null, makeQuad(), LIVE_SCENE, 0, NO_EXTRAS).tint).toBe('white');
    expect(buildHudModel(null, makeQuad(), COMIC_SCENE, 0, NO_EXTRAS).tint).toBe('red');
  });

  it('passes recording through and fps only when showFps', () => {
    const m1 = buildHudModel(null, null, LIVE_SCENE, 0, { recording: true, fps: 59.6, showFps: true });
    expect(m1.recording).toBe(true);
    expect(m1.fps).toBe(59.6);
    const m2 = buildHudModel(null, null, LIVE_SCENE, 0, { recording: false, fps: 59.6, showFps: false });
    expect(m2.fps).toBeNull();
  });

  it('records the build time for blink phase', () => {
    expect(buildHudModel(null, null, LIVE_SCENE, 1234, NO_EXTRAS).t).toBe(1234);
  });
});

describe('buildHudModel — thin slits (lead errata §4b.1/5)', () => {
  it('still emits corner + eye-left for a 2 px-tall visible slit', () => {
    const slit = makeQuad({
      corners: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }, { x: 0.7, y: 0.503 }, { x: 0.3, y: 0.503 }],
      thickness: 0.003, area: 0.0012,
    });
    const m = buildHudModel(makeFrame({ face: makeFace() }), slit, LIVE_SCENE, 0, NO_EXTRAS);
    expect(m.callouts.map((c) => c.id)).toEqual(['corner', 'eye-left']);
    expect(m.opacity).toBe(1);
  });
});
