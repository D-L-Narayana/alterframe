import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERACTION_SETTINGS, DEFAULT_SCENE } from '../../../src/types';
import type { HandTrack, InteractionEvent, InteractionSettings, SceneState } from '../../../src/types';
import { createInteraction } from '../../../src/interaction';
import { lPoseHands, makeFrame, makeHand } from './helpers';

const S: InteractionSettings = { ...DEFAULT_INTERACTION_SETTINGS };
const scene: SceneState = { ...DEFAULT_SCENE };

/** Two hands pressed palm-to-palm at screen centre: tiny area, palms 0.04 apart. */
function togetherHands(): [HandTrack, HandTrack] {
  const l = makeHand({ indexTip: { x: 0.49, y: 0.40 }, thumbTip: { x: 0.49, y: 0.46 }, palmCenter: { x: 0.48, y: 0.5 } });
  const r = makeHand({ indexTip: { x: 0.51, y: 0.40 }, thumbTip: { x: 0.51, y: 0.46 }, palmCenter: { x: 0.52, y: 0.5 } });
  return [l, r];
}

function types(ev: InteractionEvent[]): string[] {
  return ev.map((e) => e.type);
}

describe('createInteraction — hold / fade', () => {
  it('no hands, no history → null quad, no events', () => {
    const ix = createInteraction();
    const out = ix.update(makeFrame([]), 0, scene, S);
    expect(out.quad).toBeNull();
    expect(out.events).toEqual([]);
    expect(out.debug).toEqual({ armed: false, togetherMs: 0, handsUsed: 0 });
  });

  it('null frame is tolerated like an empty frame', () => {
    const ix = createInteraction();
    expect(ix.update(null, 0, scene, S).quad).toBeNull();
  });

  it('two hands → visible quad with opacity 1 and a window-open event once', () => {
    const ix = createInteraction();
    const a = ix.update(makeFrame(lPoseHands()), 0, scene, S);
    expect(a.quad?.visible).toBe(true);
    expect(a.quad?.opacity).toBe(1);
    expect(types(a.events)).toEqual(['window-open']);
    expect(a.debug.handsUsed).toBe(2);
    const b = ix.update(makeFrame(lPoseHands()), 16, scene, S);
    expect(b.events).toEqual([]);
  });

  it('hand lost: opacity 1 through holdMs, linear fade to 0 at holdMs+fadeMs, then window-close', () => {
    const ix = createInteraction();
    ix.update(makeFrame(lPoseHands()), 1000, scene, S);
    expect(ix.update(makeFrame([]), 1100, scene, S).quad?.opacity).toBe(1);
    expect(ix.update(makeFrame([]), 1300, scene, S).quad?.opacity).toBe(1); // exactly holdMs
    const mid = ix.update(makeFrame([]), 1375, scene, S).quad!;
    expect(mid.opacity).toBeCloseTo(0.5, 9);
    expect(mid.visible).toBe(true);
    const end = ix.update(makeFrame([]), 1450, scene, S);
    expect(end.quad?.opacity ?? 0).toBe(0);
    expect(end.quad?.visible ?? false).toBe(false);
    expect(types(end.events)).toEqual(['window-close']);
    // Stays closed, no duplicate close event.
    const later = ix.update(makeFrame([]), 2000, scene, S);
    expect(later.quad).toBeNull();
    expect(later.events).toEqual([]);
  });

  it('held quad keeps the last corners while fading', () => {
    const ix = createInteraction();
    const [l, r] = lPoseHands();
    const first = ix.update(makeFrame([l, r]), 0, scene, S).quad!;
    const held = ix.update(makeFrame([]), 400, scene, S).quad!;
    expect(held.corners).toEqual(first.corners);
    expect(held.area).toBe(first.area);
  });

  it('hands return mid-fade → opacity 1 immediately, no extra open event', () => {
    const ix = createInteraction();
    ix.update(makeFrame(lPoseHands()), 0, scene, S);
    ix.update(makeFrame([]), 380, scene, S); // fading
    const back = ix.update(makeFrame(lPoseHands()), 400, scene, S);
    expect(back.quad?.opacity).toBe(1);
    expect(back.events).toEqual([]);
  });

  it('re-open after a full close emits window-open again', () => {
    const ix = createInteraction();
    ix.update(makeFrame(lPoseHands()), 0, scene, S);
    ix.update(makeFrame([]), 1000, scene, S);
    const again = ix.update(makeFrame(lPoseHands()), 1016, scene, S);
    expect(types(again.events)).toEqual(['window-open']);
  });

  it('a single hand counts as lost (hold/fade applies)', () => {
    const ix = createInteraction();
    const [l] = lPoseHands();
    ix.update(makeFrame(lPoseHands()), 0, scene, S);
    const out = ix.update(makeFrame([l]), 100, scene, S);
    expect(out.quad?.opacity).toBe(1);
    expect(out.debug.handsUsed).toBe(1);
  });

  it('fadeMs = 0 closes right after holdMs without dividing by zero', () => {
    const ix = createInteraction();
    const s0 = { ...S, fadeMs: 0 };
    ix.update(makeFrame(lPoseHands()), 0, scene, s0);
    expect(ix.update(makeFrame([]), 300, scene, s0).quad?.opacity).toBe(1);
    const closed = ix.update(makeFrame([]), 301, scene, s0);
    expect(closed.quad).toBeNull();
    expect(types(closed.events)).toEqual(['window-close']);
  });

  it('non-monotonic or non-finite time never produces NaN opacity', () => {
    const ix = createInteraction();
    ix.update(makeFrame(lPoseHands()), 1000, scene, S);
    const back = ix.update(makeFrame([]), 500, scene, S); // clock went backwards
    expect(back.quad?.opacity).toBe(1);
    const nan = ix.update(makeFrame([]), Number.NaN, scene, S);
    expect(Number.isFinite(nan.quad?.opacity ?? 0)).toBe(true);
  });

  it('reset() forgets the held quad and edge state', () => {
    const ix = createInteraction();
    ix.update(makeFrame(lPoseHands()), 0, scene, S);
    ix.reset();
    const out = ix.update(makeFrame([]), 10, scene, S);
    expect(out.quad).toBeNull();
    expect(out.events).toEqual([]);
    const reopen = ix.update(makeFrame(lPoseHands()), 20, scene, S);
    expect(types(reopen.events)).toEqual(['window-open']);
  });
});

describe('createInteraction — hands-together persona cycle', () => {
  function runTogetherThenOpen(ix: ReturnType<typeof createInteraction>, togetherMs: number, t0 = 0, settings = S, sc = scene) {
    const events: InteractionEvent[] = [];
    let t = t0;
    for (; t <= t0 + togetherMs; t += 50) events.push(...ix.update(makeFrame(togetherHands()), t, sc, settings).events);
    // Open into an L pose for a few frames.
    for (let k = 0; k < 5; k++, t += 50) events.push(...ix.update(makeFrame(lPoseHands()), t, sc, settings).events);
    return { events, tEnd: t };
  }

  it('together 600 ms then open → exactly one cycle-persona with next = masked', () => {
    const ix = createInteraction();
    const { events } = runTogetherThenOpen(ix, 600);
    const cycles = events.filter((e) => e.type === 'cycle-persona');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual({ type: 'cycle-persona', next: 'masked' });
    expect(types(events)).toContain('hands-together-armed');
    expect(types(events).filter((x) => x === 'hands-together-armed')).toHaveLength(1);
  });

  it('together 300 ms then open → no cycle (not armed)', () => {
    const ix = createInteraction();
    const { events } = runTogetherThenOpen(ix, 300);
    expect(events.filter((e) => e.type === 'cycle-persona')).toHaveLength(0);
    expect(types(events)).not.toContain('hands-together-armed');
  });

  it('two together→open gestures within 1500 ms → only one cycle', () => {
    const ix = createInteraction();
    const first = runTogetherThenOpen(ix, 600, 0);
    const second = runTogetherThenOpen(ix, 600, first.tEnd);
    const all = [...first.events, ...second.events].filter((e) => e.type === 'cycle-persona');
    expect(second.tEnd).toBeLessThan(1500 + 600);
    expect(all).toHaveLength(1);
  });

  it('a second gesture after the 1500 ms debounce cycles again and follows PERSONA_ORDER', () => {
    const ix = createInteraction();
    const first = runTogetherThenOpen(ix, 600, 0);
    const masked: SceneState = { ...scene, persona: 'masked' };
    const second = runTogetherThenOpen(ix, 600, first.tEnd + 1600, S, masked);
    const cycles = second.events.filter((e) => e.type === 'cycle-persona');
    expect(cycles).toEqual([{ type: 'cycle-persona', next: 'suit' }]);
    const suit: SceneState = { ...scene, persona: 'suit' };
    const third = runTogetherThenOpen(ix, 600, second.tEnd + 1600, S, suit);
    expect(third.events.filter((e) => e.type === 'cycle-persona')).toEqual([{ type: 'cycle-persona', next: 'portrait' }]);
  });

  it('armed state fires only once even if the window stays open for a long time', () => {
    const ix = createInteraction();
    const { events, tEnd } = runTogetherThenOpen(ix, 600);
    let extra = 0;
    for (let t = tEnd; t < tEnd + 5000; t += 50) {
      extra += ix.update(makeFrame(lPoseHands()), t, scene, S).events.filter((e) => e.type === 'cycle-persona').length;
    }
    expect(events.filter((e) => e.type === 'cycle-persona').length + extra).toBe(1);
  });

  it('gestureCycleEnabled=false → never arms, never cycles', () => {
    const ix = createInteraction();
    const off = { ...S, gestureCycleEnabled: false };
    const { events } = runTogetherThenOpen(ix, 1000, 0, off);
    expect(events.filter((e) => e.type !== 'window-open' && e.type !== 'window-close')).toEqual([]);
  });

  it('together timer resets when hands separate before arming', () => {
    const ix = createInteraction();
    let t = 0;
    for (; t <= 300; t += 50) ix.update(makeFrame(togetherHands()), t, scene, S);
    ix.update(makeFrame(lPoseHands()), t, scene, S); // apart, area large
    t += 50;
    const ev: InteractionEvent[] = [];
    for (let k = 0; k <= 300; k += 50, t += 50) ev.push(...ix.update(makeFrame(togetherHands()), t, scene, S).events);
    expect(types(ev)).not.toContain('hands-together-armed');
  });

  it('debug.togetherMs grows while together and reports armed', () => {
    const ix = createInteraction();
    ix.update(makeFrame(togetherHands()), 0, scene, S);
    const mid = ix.update(makeFrame(togetherHands()), 250, scene, S);
    expect(mid.debug.togetherMs).toBe(250);
    expect(mid.debug.armed).toBe(false);
    const armed = ix.update(makeFrame(togetherHands()), 600, scene, S);
    expect(armed.debug.armed).toBe(true);
  });

  it('palms close but window already wide open does not count as together', () => {
    const ix = createInteraction();
    // Palms 0.05 apart but tips spread wide → area ≫ openArea/2.
    const l = makeHand({ indexTip: { x: 0.1, y: 0.1 }, thumbTip: { x: 0.1, y: 0.9 }, palmCenter: { x: 0.48, y: 0.5 } });
    const r = makeHand({ indexTip: { x: 0.9, y: 0.1 }, thumbTip: { x: 0.9, y: 0.9 }, palmCenter: { x: 0.53, y: 0.5 } });
    for (let t = 0; t <= 1000; t += 50) {
      const out = ix.update(makeFrame([l, r]), t, scene, S);
      expect(out.debug.togetherMs).toBe(0);
      expect(out.debug.armed).toBe(false);
    }
  });

  it('armed state is dropped if hands disappear for longer than the disarm timeout', () => {
    const ix = createInteraction();
    let t = 0;
    for (; t <= 600; t += 50) ix.update(makeFrame(togetherHands()), t, scene, S);
    for (let k = 0; k < 3000; k += 50, t += 50) ix.update(makeFrame([]), t, scene, S);
    const out = ix.update(makeFrame(lPoseHands()), t, scene, S);
    expect(out.events.filter((e) => e.type === 'cycle-persona')).toHaveLength(0);
  });
});

describe('createInteraction — optional corner spring', () => {
  it('with cornerSpring enabled the quad lags the target then converges within a few frames', () => {
    const ix = createInteraction({ cornerSpring: { stiffness: 0.35 } });
    const [l, r] = lPoseHands();
    const first = ix.update(makeFrame([l, r]), 0, scene, S).quad!;
    // First frame snaps exactly (no history to lag from).
    expect(first.corners[0]).toEqual(l.indexTip);
    const l2 = { ...l, indexTip: { x: 0.35, y: 0.30 } };
    l2.landmarks = l.landmarks;
    let q = ix.update(makeFrame([l2, r]), 16, scene, S).quad!;
    expect(q.corners[0].x).toBeGreaterThan(0.25);
    expect(q.corners[0].x).toBeLessThan(0.35);
    for (let t = 32; t < 1000; t += 16) q = ix.update(makeFrame([l2, r]), t, scene, S).quad!;
    expect(q.corners[0].x).toBeCloseTo(0.35, 4);
  });

  it('spring is off by default → corners equal the tips every frame', () => {
    const ix = createInteraction();
    const [l, r] = lPoseHands();
    ix.update(makeFrame([l, r]), 0, scene, S);
    const l2 = { ...l, indexTip: { x: 0.35, y: 0.30 } };
    const q = ix.update(makeFrame([l2, r]), 16, scene, S).quad!;
    expect(q.corners[0]).toEqual({ x: 0.35, y: 0.30 });
  });
});
