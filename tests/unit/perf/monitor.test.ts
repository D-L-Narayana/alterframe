import { describe, it, expect } from 'vitest';
import { createPerfMonitor } from '@/perf/monitor';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const frame = (frameMs: number) => ({ frameMs, trackingMs: frameMs * 0.6, renderMs: frameMs * 0.3 });

describe('createPerfMonitor', () => {
  it('reports 0 fps before two samples exist', () => {
    const c = clock();
    const m = createPerfMonitor({ now: c.now });
    expect(m.fps()).toBe(0);
    m.sample(frame(16));
    expect(m.fps()).toBe(0);
  });

  it('converges to the steady-state frame rate (EMA over ~500 ms)', () => {
    const c = clock();
    const m = createPerfMonitor({ now: c.now });
    for (let i = 0; i < 120; i++) {
      m.sample(frame(16.7));
      c.advance(1000 / 60);
    }
    expect(m.fps()).toBeGreaterThan(59);
    expect(m.fps()).toBeLessThan(61);
  });

  it('smooths: after a steady 60 fps, one 100 ms hitch dents fps by less than a third', () => {
    const c = clock();
    const m = createPerfMonitor({ now: c.now });
    for (let i = 0; i < 120; i++) {
      m.sample(frame(16.7));
      c.advance(1000 / 60);
    }
    c.advance(100 - 1000 / 60); // one long gap
    m.sample(frame(100));
    expect(m.fps()).toBeGreaterThan(40);
    expect(m.fps()).toBeLessThan(60);
  });

  it('tracks a drop from 60 to 20 fps within about one second', () => {
    const c = clock();
    const m = createPerfMonitor({ now: c.now });
    for (let i = 0; i < 60; i++) {
      m.sample(frame(16));
      c.advance(1000 / 60);
    }
    for (let i = 0; i < 20; i++) {
      c.advance(50);
      m.sample(frame(50));
    }
    expect(m.fps()).toBeGreaterThan(18);
    expect(m.fps()).toBeLessThan(27); // tau = 500 ms → ~86 % converged after 1 s
  });

  it('stamps each sample with t and the current fps', () => {
    const c = clock(5000);
    const m = createPerfMonitor({ now: c.now });
    m.sample(frame(16));
    c.advance(16);
    m.sample({ frameMs: 16, trackingMs: 9, renderMs: 4 });
    const last = m.recent(100).at(-1)!;
    expect(last.t).toBe(5016);
    expect(last.frameMs).toBe(16);
    expect(last.trackingMs).toBe(9);
    expect(last.renderMs).toBe(4);
    expect(last.fps).toBe(m.fps());
  });

  it('recent(ms) returns only samples within the window, oldest first', () => {
    const c = clock();
    const m = createPerfMonitor({ now: c.now });
    for (let i = 0; i < 10; i++) {
      m.sample(frame(100));
      c.advance(100);
    }
    // now = 1000; samples at t = 0..900
    const r = m.recent(250);
    expect(r.map((s) => s.t)).toEqual([800, 900]);
    expect(m.recent(10_000)).toHaveLength(10);
  });

  it('keeps a 5 s ring buffer and drops older samples', () => {
    const c = clock();
    const m = createPerfMonitor({ now: c.now });
    for (let i = 0; i < 1000; i++) {
      m.sample(frame(10));
      c.advance(10);
    }
    const all = m.recent(60_000);
    expect(all.length).toBeLessThanOrEqual(501);
    expect(all[0]!.t).toBeGreaterThanOrEqual(c.now() - 5000 - 10);
    expect(all.at(-1)!.t).toBe(9990);
  });

  it('ignores a zero-dt duplicate call without producing Infinity', () => {
    const c = clock();
    const m = createPerfMonitor({ now: c.now });
    m.sample(frame(16));
    m.sample(frame(16));
    expect(Number.isFinite(m.fps())).toBe(true);
    c.advance(16);
    m.sample(frame(16));
    expect(Number.isFinite(m.fps())).toBe(true);
  });

  it('after a long pause (tab hidden) the next sample re-seeds instead of collapsing fps', () => {
    const c = clock();
    const m = createPerfMonitor({ now: c.now });
    for (let i = 0; i < 60; i++) {
      m.sample(frame(16));
      c.advance(1000 / 60);
    }
    c.advance(30_000);
    m.sample(frame(16));
    c.advance(1000 / 60);
    m.sample(frame(16));
    expect(m.fps()).toBeGreaterThan(30);
  });
});
