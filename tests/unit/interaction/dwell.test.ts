import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERACTION_SETTINGS, DEFAULT_SCENE } from '../../../src/types';
import type { HandTrack, Interaction, InteractionEvent, InteractionSettings, QuadCorners, SceneState, Vec2 } from '../../../src/types';
import { createInteraction } from '../../../src/interaction';
import { createDwellDetector } from '../../../src/interaction/dwell';
import { makeFrame, makeHand, rng } from './helpers';

const DWELL = 1500;
const TOL = DEFAULT_INTERACTION_SETTINGS.dwellTolerance; // 0.012
const S: InteractionSettings = { ...DEFAULT_INTERACTION_SETTINGS, dwellMs: DWELL };
const scene: SceneState = { ...DEFAULT_SCENE };
/** Frame period (ms). 16 is exact in binary floating point, so frame times are exact multiples. */
const DT = 16;

/** L pose shifted by `offset`; `jitter(i)` adds an independent offset to tip i (0 L.index, 1 L.thumb, 2 R.index, 3 R.thumb). */
function pose(offset: Vec2 = { x: 0, y: 0 }, jitter?: (i: number) => Vec2): HandTrack[] {
  const add = (p: Vec2, i: number): Vec2 => {
    const j = jitter ? jitter(i) : { x: 0, y: 0 };
    return { x: p.x + offset.x + j.x, y: p.y + offset.y + j.y };
  };
  const left = makeHand({ side: 'left', indexTip: add({ x: 0.25, y: 0.3 }, 0), thumbTip: add({ x: 0.3, y: 0.6 }, 1), palmCenter: { x: 0.22 + offset.x, y: 0.55 + offset.y } });
  const right = makeHand({ side: 'right', indexTip: add({ x: 0.75, y: 0.32 }, 2), thumbTip: add({ x: 0.7, y: 0.62 }, 3), palmCenter: { x: 0.78 + offset.x, y: 0.55 + offset.y } });
  return [left, right];
}

interface Frame { t: number; events: InteractionEvent[]; progress: number; opacity: number | null }

/** Drives `ix` from t0 (inclusive) to t1 (exclusive) in DT steps; `handsAt(t)` returns the hands, or null for a lost pair. */
function drive(
  ix: Interaction,
  settings: InteractionSettings | ((t: number) => InteractionSettings),
  t0: number,
  t1: number,
  handsAt: (t: number) => HandTrack[] | null,
): Frame[] {
  const out: Frame[] = [];
  for (let t = t0; t < t1; t += DT) {
    const s = typeof settings === 'function' ? settings(t) : settings;
    const o = ix.update(makeFrame(handsAt(t) ?? [], t), t, scene, s);
    out.push({ t, events: o.events, progress: o.debug.dwellProgress ?? Number.NaN, opacity: o.quad ? o.quad.opacity : null });
  }
  return out;
}

const dwellTimes = (trace: Frame[]): number[] => trace.filter((f) => f.events.some((e) => e.type === 'dwell')).map((f) => f.t);
const at = (trace: Frame[], t: number): Frame => {
  const f = trace.find((x) => x.t === t);
  if (!f) throw new Error(`no frame at ${t}`);
  return f;
};

describe('createInteraction — hold-still (dwell) detector', () => {
  it('steady pose → exactly one dwell event, on the first frame at or after dwellMs, never before', () => {
    const ix = createInteraction();
    const trace = drive(ix, S, 0, 3000, () => pose());
    const times = dwellTimes(trace);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(DWELL);
    expect(times[0]).toBeLessThan(DWELL + DT);
    // The firing frame carries only the dwell event.
    expect(at(trace, times[0]!).events).toEqual([{ type: 'dwell' }]);
  });

  it('dwellProgress ramps linearly from 0 to 1 and stays at 1 while the pose stays still after firing', () => {
    const ix = createInteraction();
    const trace = drive(ix, S, 0, 4000, () => pose());
    expect(trace[0]!.progress).toBe(0);
    expect(at(trace, 752).progress).toBeCloseTo(752 / DWELL, 9);
    for (let i = 1; i < trace.length; i++) expect(trace[i]!.progress).toBeGreaterThanOrEqual(trace[i - 1]!.progress);
    const fireT = dwellTimes(trace)[0]!;
    for (const f of trace) {
      expect(f.progress).toBeGreaterThanOrEqual(0);
      expect(f.progress).toBeLessThanOrEqual(1);
      if (f.t >= fireT) expect(f.progress).toBe(1);
      else expect(f.progress).toBeLessThan(1);
    }
  });

  it('jitter below the tolerance still counts as holding still', () => {
    const ix = createInteraction();
    // Every tip wobbles on a circle of radius 0.0055 (< tolerance / 2) → any two samples differ by < 0.011.
    const r = 0.0055;
    const trace = drive(ix, S, 0, 3000, (t) =>
      pose({ x: 0, y: 0 }, (i) => {
        const a = (t / DT) * 2.399 + i * 1.3;
        return { x: Math.cos(a) * r, y: Math.sin(a) * r };
      }),
    );
    const times = dwellTimes(trace);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(DWELL);
    expect(times[0]).toBeLessThan(DWELL + DT);
  });

  it('motion above the tolerance resets the progress; the hold restarts from the new position', () => {
    const ix = createInteraction();
    const moveT = 1008;
    const trace = drive(ix, S, 0, 4000, (t) => pose(t < moveT ? { x: 0, y: 0 } : { x: 0.05, y: 0 }));
    expect(at(trace, moveT - DT).progress).toBeCloseTo((moveT - DT) / DWELL, 9);
    expect(at(trace, moveT).progress).toBe(0);
    const times = dwellTimes(trace);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(moveT + DWELL);
    expect(times[0]).toBeLessThan(moveT + DWELL + DT);
  });

  it('a single corner moving beyond the tolerance is motion too', () => {
    const ix = createInteraction();
    const moveT = 1008;
    // Only the left index tip (corner TL) jumps by 0.02.
    const trace = drive(ix, S, 0, 2000, (t) => pose({ x: 0, y: 0 }, (i) => (i === 0 && t >= moveT ? { x: 0.02, y: 0 } : { x: 0, y: 0 })));
    expect(at(trace, moveT - DT).progress).toBeGreaterThan(0.6);
    expect(at(trace, moveT).progress).toBe(0);
    expect(dwellTimes(trace)).toEqual([]); // 2000 − 1008 < dwellMs
  });

  it('no event and zero progress while the window is held or fading (pair lost); the hold restarts when hands return', () => {
    const ix = createInteraction();
    const lostFrom = 1000;
    const backAt = 3000;
    const trace = drive(ix, S, 0, 6000, (t) => (t < lostFrom || t >= backAt ? pose() : null));
    const lost = trace.filter((f) => f.t >= lostFrom && f.t < backAt);
    // Held (opacity 1) for holdMs, then fading, then closed — never live.
    expect(lost.some((f) => f.opacity === 1)).toBe(true);
    expect(lost.some((f) => f.opacity !== null && f.opacity > 0 && f.opacity < 1)).toBe(true);
    expect(lost.some((f) => f.opacity === null)).toBe(true);
    for (const f of lost) {
      expect(f.progress).toBe(0);
      expect(f.events.some((e) => e.type === 'dwell')).toBe(false);
    }
    const times = dwellTimes(trace);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(backAt + DWELL);
    expect(times[0]).toBeLessThan(backAt + DWELL + DT);
  });

  it('a one-frame tracking dropout restarts the hold (a live pair is required on every frame)', () => {
    const ix = createInteraction();
    const trace = drive(ix, S, 0, 3000, (t) => (t === 1008 ? null : pose()));
    expect(at(trace, 1008).progress).toBe(0);
    expect(at(trace, 1008).opacity).toBe(1); // held, not live
    const times = dwellTimes(trace);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(1024 + DWELL);
    expect(times[0]).toBeLessThan(1024 + DWELL + DT);
  });

  it('re-arms after motion: still → event, move, still → second event', () => {
    const ix = createInteraction();
    const trace = drive(ix, S, 0, 6000, (t) => pose(t < 2000 ? { x: 0, y: 0 } : t < 2500 ? { x: 0.1, y: 0 } : { x: 0.2, y: 0 }));
    const times = dwellTimes(trace);
    expect(times).toHaveLength(2);
    expect(times[0]).toBeLessThan(DWELL + DT);
    // The second hold starts on the frame that detected the last motion (progress 0 there).
    const restart = Math.max(...trace.filter((f) => f.t >= 2000 && f.progress === 0).map((f) => f.t));
    expect(restart).toBeGreaterThanOrEqual(2500);
    expect(times[1]).toBeGreaterThanOrEqual(restart + DWELL);
    expect(times[1]).toBeLessThan(restart + DWELL + DT);
  });

  it('one event per episode: no second event while the pose simply stays still after firing', () => {
    const ix = createInteraction();
    const trace = drive(ix, S, 0, 10_000, () => pose());
    expect(dwellTimes(trace)).toHaveLength(1);
    expect(trace[trace.length - 1]!.progress).toBe(1);
  });

  it('reset() re-arms: the same still pose fires again dwellMs after the reset', () => {
    const ix = createInteraction();
    expect(dwellTimes(drive(ix, S, 0, 2000, () => pose()))).toHaveLength(1);
    ix.reset();
    const b = drive(ix, S, 2000, 4000, () => pose());
    expect(b[0]!.progress).toBe(0);
    const times = dwellTimes(b);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(2000 + DWELL);
    expect(times[0]).toBeLessThan(2000 + DWELL + DT);
  });

  it('dwellMs 0 (the default) disables the detector: no events, dwellProgress 0 on every frame', () => {
    const ix = createInteraction();
    const trace = drive(ix, DEFAULT_INTERACTION_SETTINGS, 0, 3000, () => pose());
    expect(dwellTimes(trace)).toEqual([]);
    for (const f of trace) expect(f.progress).toBe(0);
  });

  it('switching dwellMs to 0 mid-hold drops the progress and re-arms; switching back starts a fresh hold', () => {
    const ix = createInteraction();
    const settingsAt = (t: number): InteractionSettings => (t >= 1000 && t < 1200 ? { ...S, dwellMs: 0 } : S);
    const trace = drive(ix, settingsAt, 0, 4000, () => pose());
    expect(at(trace, 992).progress).toBeGreaterThan(0.6);
    expect(at(trace, 1008).progress).toBe(0);
    expect(at(trace, 1200).progress).toBe(0); // fresh hold, not a resumed one
    const times = dwellTimes(trace);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(1200 + DWELL);
    expect(times[0]).toBeLessThan(1200 + DWELL + DT);
  });

  it('lowering dwellMs below the elapsed hold fires on the next frame; raising it after firing does not re-fire', () => {
    const ix = createInteraction();
    const settingsAt = (t: number): InteractionSettings => (t < 1000 ? S : t < 2000 ? { ...S, dwellMs: 800 } : { ...S, dwellMs: 3000 });
    const trace = drive(ix, settingsAt, 0, 5000, () => pose());
    expect(dwellTimes(trace)).toEqual([1008]);
    for (const f of trace) if (f.t >= 1008) expect(f.progress).toBe(1);
  });

  it('tolerates a non-finite clock and a clock going backwards without NaN or spurious events', () => {
    const ix = createInteraction();
    const hands = pose();
    ix.update(makeFrame(hands, 0), 0, scene, S);
    ix.update(makeFrame(hands, 500), 500, scene, S);
    const nan = ix.update(makeFrame(hands, Number.NaN), Number.NaN, scene, S);
    expect(Number.isFinite(nan.debug.dwellProgress)).toBe(true);
    expect(nan.events).toEqual([]);
    const back = ix.update(makeFrame(hands, 100), 100, scene, S);
    expect(back.debug.dwellProgress).toBeGreaterThanOrEqual(0);
    expect(back.debug.dwellProgress).toBeLessThanOrEqual(1);
    expect(back.events).toEqual([]);
    // Time resumes from 100: the event arrives dwellMs later, exactly once.
    const trace = drive(ix, S, 116, 3000, () => hands);
    for (const f of trace) expect(Number.isFinite(f.progress)).toBe(true);
    const times = dwellTimes(trace);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(100 + DWELL);
  });

  it('tracks the fingertips, not the spring-smoothed corners (a laggy spring does not delay the event)', () => {
    const ix = createInteraction();
    const s: InteractionSettings = { ...S, cornerSpring: 0.05 }; // very laggy: 5 % of the gap per 60 Hz frame
    const jumpT = 496;
    const trace = drive(ix, s, 0, 3000, (t) => pose(t < jumpT ? { x: 0, y: 0 } : { x: 0.2, y: 0 }));
    const times = dwellTimes(trace);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(jumpT + DWELL);
    expect(times[0]).toBeLessThan(jumpT + DWELL + DT);
  });
});

describe('dwell — seeded property tests', () => {
  it('random jitter inside the tolerance over 3 s always yields exactly one event', () => {
    const random = rng(20261004);
    const r = TOL / 2 - 1e-4;
    for (let trial = 0; trial < 25; trial++) {
      const ix = createInteraction();
      const trace = drive(ix, S, 0, 3000, () =>
        pose({ x: 0, y: 0 }, () => {
          const a = random() * Math.PI * 2;
          const d = random() * r;
          return { x: Math.cos(a) * d, y: Math.sin(a) * d };
        }),
      );
      const times = dwellTimes(trace);
      expect(times).toHaveLength(1);
      expect(times[0]).toBeGreaterThanOrEqual(DWELL);
      expect(times[0]).toBeLessThan(DWELL + DT);
    }
  });

  it('a random walk whose every step exceeds the tolerance never fires and keeps the progress at 0', () => {
    const random = rng(777);
    for (let trial = 0; trial < 25; trial++) {
      const ix = createInteraction();
      let ox = 0;
      let oy = 0;
      const trace = drive(ix, S, 0, 3000, () => {
        const a = random() * Math.PI * 2;
        const step = TOL * (1.05 + random() * 2);
        let dx = Math.cos(a) * step;
        let dy = Math.sin(a) * step;
        if (Math.abs(ox + dx) > 0.2) dx = -dx; // stay inside the frame
        if (Math.abs(oy + dy) > 0.2) dy = -dy;
        ox += dx;
        oy += dy;
        return pose({ x: ox, y: oy });
      });
      expect(dwellTimes(trace)).toEqual([]);
      for (const f of trace) expect(f.progress).toBe(0);
    }
  });

  it('arbitrary motion with dropouts keeps dwellProgress finite within [0, 1] and bounds the event count', () => {
    const random = rng(99);
    for (let trial = 0; trial < 10; trial++) {
      const ix = createInteraction();
      let ox = 0;
      let oy = 0;
      const trace = drive(ix, S, 0, 6000, () => {
        if (random() < 0.02) return null; // occasional dropout
        if (random() < 0.1) {
          ox = (random() - 0.5) * 0.3; // occasional jump
          oy = (random() - 0.5) * 0.3;
        }
        const r = random() * TOL * 0.4;
        const a = random() * Math.PI * 2;
        return pose({ x: ox, y: oy }, () => ({ x: Math.cos(a) * r, y: Math.sin(a) * r }));
      });
      for (const f of trace) {
        expect(Number.isFinite(f.progress)).toBe(true);
        expect(f.progress).toBeGreaterThanOrEqual(0);
        expect(f.progress).toBeLessThanOrEqual(1);
      }
      expect(dwellTimes(trace).length).toBeLessThanOrEqual(Math.floor(6000 / DWELL));
    }
  });
});

describe('createDwellDetector (unit)', () => {
  const sq = (o = 0): QuadCorners => [{ x: 0.2 + o, y: 0.2 }, { x: 0.8 + o, y: 0.2 }, { x: 0.8 + o, y: 0.8 }, { x: 0.2 + o, y: 0.8 }];

  it('starts idle; a steady target fires once at dwellMs and then reports progress 1', () => {
    const d = createDwellDetector();
    expect(d.progress).toBe(0);
    const fired: number[] = [];
    for (let t = 0; t <= 3000; t += DT) if (d.update(sq(), t, DWELL, TOL)) fired.push(t);
    expect(fired).toEqual([1504]);
    expect(d.progress).toBe(1);
  });

  it('null corners (no live quad) and dwellMs 0 end the episode and report progress 0', () => {
    const d = createDwellDetector();
    for (let t = 0; t < 1000; t += DT) d.update(sq(), t, DWELL, TOL);
    expect(d.progress).toBeGreaterThan(0.6);
    expect(d.update(null, 1000, DWELL, TOL)).toBe(false);
    expect(d.progress).toBe(0);
    for (let t = 1016; t < 2000; t += DT) d.update(sq(), t, DWELL, TOL);
    expect(d.progress).toBeGreaterThan(0.6);
    expect(d.update(sq(), 2000, 0, TOL)).toBe(false);
    expect(d.progress).toBe(0);
  });

  it('a slow drift that exceeds the tolerance within one window is motion; a slower one is not', () => {
    const fast = createDwellDetector();
    let fastFires = 0;
    let maxP = 0;
    for (let t = 0; t <= 6000; t += DT) {
      if (fast.update(sq((t / DWELL) * 0.02), t, DWELL, TOL)) fastFires++;
      maxP = Math.max(maxP, fast.progress);
    }
    expect(fastFires).toBe(0);
    expect(maxP).toBeLessThan(0.75);
    const slow = createDwellDetector();
    let slowFires = 0;
    for (let t = 0; t <= 6000; t += DT) if (slow.update(sq((t / DWELL) * 0.006), t, DWELL, TOL)) slowFires++;
    expect(slowFires).toBe(1);
  });

  it('non-finite corner coordinates are not a live quad', () => {
    const d = createDwellDetector();
    for (let t = 0; t < 1000; t += DT) d.update(sq(), t, DWELL, TOL);
    const bad: QuadCorners = [{ x: Number.NaN, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];
    expect(d.update(bad, 1000, DWELL, TOL)).toBe(false);
    expect(d.progress).toBe(0);
  });

  it('a non-finite tolerance falls back to the default (0.012)', () => {
    const d = createDwellDetector();
    let fires = 0;
    // Jitter of 0.005 per corner (under the default tolerance) with a NaN tolerance still completes.
    for (let t = 0; t <= 2000; t += DT) if (d.update(sq((t / DT) % 2 === 0 ? 0 : 0.005), t, DWELL, Number.NaN)) fires++;
    expect(fires).toBe(1);
    const e = createDwellDetector();
    let fires2 = 0;
    for (let t = 0; t <= 2000; t += DT) if (e.update(sq((t / DT) % 2 === 0 ? 0 : 0.02), t, DWELL, Number.NaN)) fires2++;
    expect(fires2).toBe(0);
  });

  it('a long frame gap (hidden tab): an unchanged pose completes the hold, a changed pose restarts it', () => {
    const same = createDwellDetector();
    same.update(sq(), 0, DWELL, TOL);
    same.update(sq(), 16, DWELL, TOL);
    expect(same.update(sq(), 5000, DWELL, TOL)).toBe(true);
    const moved = createDwellDetector();
    moved.update(sq(), 0, DWELL, TOL);
    moved.update(sq(), 16, DWELL, TOL);
    expect(moved.update(sq(0.1), 5000, DWELL, TOL)).toBe(false);
    expect(moved.progress).toBe(0);
  });

  it('non-finite time is ignored (state kept); a clock going backwards restarts the window without NaN', () => {
    const d = createDwellDetector();
    for (let t = 0; t <= 1000; t += DT) d.update(sq(), t, DWELL, TOL);
    const p = d.progress;
    expect(d.update(sq(), Number.NaN, DWELL, TOL)).toBe(false);
    expect(d.progress).toBe(p);
    expect(d.update(sq(), 200, DWELL, TOL)).toBe(false);
    expect(Number.isFinite(d.progress)).toBe(true);
    expect(d.progress).toBeGreaterThanOrEqual(0);
    expect(d.progress).toBeLessThanOrEqual(1);
    let fires = 0;
    for (let t = 216; t <= 3000; t += DT) if (d.update(sq(), t, DWELL, TOL)) fires++;
    expect(fires).toBe(1);
  });

  it('stays bounded over long episodes at high frame rates (ring buffer) and still fires exactly once', () => {
    const d = createDwellDetector();
    let fires = 0;
    for (let t = 0; t <= 20_000; t += 1) if (d.update(sq(), t, DWELL, TOL)) fires++; // 1 kHz for 20 s
    expect(fires).toBe(1);
    expect(d.progress).toBe(1);
    // Motion is still detected after a long still stretch.
    expect(d.update(sq(0.05), 20_001, DWELL, TOL)).toBe(false);
    expect(d.progress).toBe(0);
  });

  it('reset() re-arms', () => {
    const d = createDwellDetector();
    let fires = 0;
    for (let t = 0; t <= 2000; t += DT) if (d.update(sq(), t, DWELL, TOL)) fires++;
    d.reset();
    expect(d.progress).toBe(0);
    for (let t = 2016; t <= 4000; t += DT) if (d.update(sq(), t, DWELL, TOL)) fires++;
    expect(fires).toBe(2);
  });
});
