import { describe, it, expect, vi } from 'vitest';
import { WarmQueue, pickIdleScheduler, type IdleScheduler } from '../../../src/render/core/warm';

/** Deterministic idle scheduler: callbacks run only when the test calls `tick()`. */
function fakeScheduler() {
  const pending: (() => void)[] = [];
  const schedule: IdleScheduler = (run) => {
    pending.push(run);
    return () => {
      const i = pending.indexOf(run);
      if (i >= 0) pending.splice(i, 1);
    };
  };
  return {
    schedule,
    tick(): void {
      const run = pending.shift();
      run?.();
    },
    get size(): number {
      return pending.length;
    },
  };
}

describe('WarmQueue (chunked per item over an idle scheduler)', () => {
  it('runs everything synchronously when no scheduler exists (e.g. Node tests)', () => {
    const done: string[] = [];
    const q = new WarmQueue<string>((s) => done.push(s), null);
    q.push(['a', 'b', 'c']);
    expect(done).toEqual(['a', 'b', 'c']);
    expect(q.pending).toBe(0);
  });

  it('processes exactly one item per idle slot and re-arms until the queue is empty', () => {
    const s = fakeScheduler();
    const done: string[] = [];
    const q = new WarmQueue<string>((x) => done.push(x), s.schedule);
    q.push(['a', 'b', 'c']);
    expect(done).toEqual([]);
    expect(q.pending).toBe(3);
    expect(s.size).toBe(1); // one slot armed, not three
    s.tick();
    expect(done).toEqual(['a']);
    expect(q.pending).toBe(2);
    expect(s.size).toBe(1);
    s.tick();
    s.tick();
    expect(done).toEqual(['a', 'b', 'c']);
    expect(q.pending).toBe(0);
    expect(s.size).toBe(0); // nothing left armed
  });

  it('is idempotent while queued: pushing the same items again does not duplicate work', () => {
    const s = fakeScheduler();
    const done: string[] = [];
    const q = new WarmQueue<string>((x) => done.push(x), s.schedule);
    q.push(['a', 'b']);
    q.push(['b', 'a', 'c']);
    expect(q.pending).toBe(3);
    expect(s.size).toBe(1);
    for (let i = 0; i < 5; i++) s.tick();
    expect(done).toEqual(['a', 'b', 'c']);
  });

  it('items pushed while an item is being processed are appended and processed in later slots', () => {
    const s = fakeScheduler();
    const done: string[] = [];
    const q: WarmQueue<string> = new WarmQueue<string>((x) => {
      done.push(x);
      if (x === 'a') q.push(['late']);
    }, s.schedule);
    q.push(['a', 'b']);
    s.tick();
    expect(done).toEqual(['a']);
    expect(q.pending).toBe(2);
    s.tick();
    s.tick();
    expect(done).toEqual(['a', 'b', 'late']);
    expect(s.size).toBe(0);
  });

  it('dispose cancels the armed slot and drops queued items', () => {
    const s = fakeScheduler();
    const done: string[] = [];
    const q = new WarmQueue<string>((x) => done.push(x), s.schedule);
    q.push(['a', 'b', 'c']);
    s.tick();
    q.dispose();
    expect(q.pending).toBe(0);
    expect(s.size).toBe(0);
    s.tick();
    expect(done).toEqual(['a']);
  });

  it('a failing item is reported and does not stop the rest of the queue', () => {
    const s = fakeScheduler();
    const done: string[] = [];
    const errors: [unknown, string][] = [];
    const q = new WarmQueue<string>(
      (x) => {
        if (x === 'bad') throw new Error('shader build failed');
        done.push(x);
      },
      s.schedule,
      (e, item) => errors.push([e, item]),
    );
    q.push(['a', 'bad', 'c']);
    s.tick();
    s.tick();
    s.tick();
    expect(done).toEqual(['a', 'c']);
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toBe('bad');
    expect((errors[0]![0] as Error).message).toMatch(/shader build failed/);
    // Synchronous mode behaves the same.
    const sync = new WarmQueue<string>((x) => { if (x === 'bad') throw new Error('x'); done.push(x); }, null, () => {});
    expect(() => sync.push(['bad', 'd'])).not.toThrow();
    expect(done).toEqual(['a', 'c', 'd']);
  });
});

describe('pickIdleScheduler', () => {
  it('prefers requestIdleCallback and cancels through cancelIdleCallback', () => {
    const ric = vi.fn((cb: (d: IdleDeadline) => void) => {
      cb({ didTimeout: false, timeRemaining: () => 10 });
      return 7;
    });
    const cic = vi.fn();
    const st = vi.fn();
    const s = pickIdleScheduler({ requestIdleCallback: ric, cancelIdleCallback: cic, setTimeout: st });
    expect(s).not.toBeNull();
    const run = vi.fn();
    const cancel = s!(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ric).toHaveBeenCalledTimes(1);
    expect(st).not.toHaveBeenCalled();
    cancel();
    expect(cic).toHaveBeenCalledWith(7);
  });

  it('falls back to setTimeout(0) when requestIdleCallback is missing', () => {
    const st = vi.fn((cb: () => void, _ms: number) => {
      cb();
      return 'timer-1';
    });
    const ct = vi.fn();
    const s = pickIdleScheduler({ setTimeout: st, clearTimeout: ct });
    expect(s).not.toBeNull();
    const run = vi.fn();
    const cancel = s!(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(st.mock.calls[0]![1]).toBe(0);
    cancel();
    expect(ct).toHaveBeenCalledWith('timer-1');
  });

  it('returns null when neither exists (callers then run synchronously)', () => {
    expect(pickIdleScheduler({})).toBeNull();
  });

  it('defaults to the real globals (Node has setTimeout, so a scheduler exists)', () => {
    expect(pickIdleScheduler()).not.toBeNull();
  });
});
