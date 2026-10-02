import { describe, expect, it } from 'vitest';
import { REFERENCE_SEQUENCE } from '../../../src/types';
import type { DirectorStep } from '../../../src/types';
import { createDirector, sceneForStep, stepIndexAt } from '../../../src/interaction/director';

const TOTAL = REFERENCE_SEQUENCE.reduce((s, x) => s + x.durationMs, 0); // 23 600

describe('stepIndexAt (pure)', () => {
  it('maps elapsed time to the reference steps and wraps', () => {
    expect(stepIndexAt(REFERENCE_SEQUENCE, 0)).toBe(0);
    expect(stepIndexAt(REFERENCE_SEQUENCE, 13_900)).toBe(1);
    expect(stepIndexAt(REFERENCE_SEQUENCE, 15_500)).toBe(2);
    expect(stepIndexAt(REFERENCE_SEQUENCE, 20_500)).toBe(3);
    expect(stepIndexAt(REFERENCE_SEQUENCE, 22_300)).toBe(4);
    expect(stepIndexAt(REFERENCE_SEQUENCE, TOTAL)).toBe(0);
    expect(stepIndexAt(REFERENCE_SEQUENCE, TOTAL + 13_900)).toBe(1);
  });
  it('boundaries belong to the following step (half-open intervals)', () => {
    expect(stepIndexAt(REFERENCE_SEQUENCE, 13_800)).toBe(1);
    expect(stepIndexAt(REFERENCE_SEQUENCE, 13_799.999)).toBe(0);
  });
  it('skips non-positive durations and returns -1 for an empty / zero-length sequence', () => {
    const seq: DirectorStep[] = [
      { base: 'live', persona: 'portrait', durationMs: 0 },
      { base: 'comic', persona: 'suit', durationMs: 100 },
      { base: 'live', persona: 'masked', durationMs: -5 },
    ];
    expect(stepIndexAt(seq, 0)).toBe(1);
    expect(stepIndexAt(seq, 99)).toBe(1);
    expect(stepIndexAt([], 10)).toBe(-1);
    expect(stepIndexAt([{ base: 'live', persona: 'portrait', durationMs: 0 }], 10)).toBe(-1);
  });
  it('negative elapsed clamps to the first step; non-finite elapsed → first step', () => {
    expect(stepIndexAt(REFERENCE_SEQUENCE, -500)).toBe(0);
    expect(stepIndexAt(REFERENCE_SEQUENCE, Number.NaN)).toBe(0);
  });
});

describe('sceneForStep', () => {
  it('derives hudTint red for comic and white for live', () => {
    expect(sceneForStep({ base: 'comic', persona: 'masked', durationMs: 1 })).toEqual({ base: 'comic', persona: 'masked', hudTint: 'red' });
    expect(sceneForStep({ base: 'live', persona: 'suit', durationMs: 1 })).toEqual({ base: 'live', persona: 'suit', hudTint: 'white' });
  });
});

describe('createDirector', () => {
  it('is not running initially and update returns null', () => {
    const d = createDirector();
    expect(d.running).toBe(false);
    expect(d.update(123)).toBeNull();
  });

  it('plays the reference sequence relative to start time', () => {
    const d = createDirector();
    d.start(1000);
    expect(d.running).toBe(true);
    const at = (ms: number) => d.update(1000 + ms);
    expect(at(0)).toEqual({ base: 'live', persona: 'portrait', hudTint: 'white' });
    expect(at(13_900)).toEqual({ base: 'live', persona: 'masked', hudTint: 'white' });
    expect(at(15_500)).toEqual({ base: 'comic', persona: 'masked', hudTint: 'red' });
    expect(at(20_500)).toEqual({ base: 'live', persona: 'portrait', hudTint: 'white' });
    expect(at(22_300)).toEqual({ base: 'comic', persona: 'suit', hudTint: 'red' });
    expect(at(23_700)).toEqual({ base: 'live', persona: 'portrait', hudTint: 'white' }); // looped
    expect(d.stepIndex(1000 + 23_700)).toBe(0);
  });

  it('returns a fresh object each update (callers may mutate)', () => {
    const d = createDirector();
    d.start(0);
    const a = d.update(1);
    const b = d.update(2);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('stop() → running false, update null; start() again restarts from step 0', () => {
    const d = createDirector();
    d.start(0);
    d.update(20_000);
    d.stop();
    expect(d.running).toBe(false);
    expect(d.update(20_016)).toBeNull();
    d.start(50_000);
    expect(d.update(50_000)?.persona).toBe('portrait');
  });

  it('accepts a custom sequence and reports its step index', () => {
    const seq: DirectorStep[] = [
      { base: 'comic', persona: 'suit', durationMs: 100 },
      { base: 'live', persona: 'masked', durationMs: 200 },
    ];
    const d = createDirector(seq);
    d.start(0);
    expect(d.update(50)).toEqual({ base: 'comic', persona: 'suit', hudTint: 'red' });
    expect(d.update(150)).toEqual({ base: 'live', persona: 'masked', hudTint: 'white' });
    expect(d.update(300)).toEqual({ base: 'comic', persona: 'suit', hudTint: 'red' });
    expect(d.stepIndex(150)).toBe(1);
  });

  it('empty sequence: running but update returns null', () => {
    const d = createDirector([]);
    d.start(0);
    expect(d.running).toBe(true);
    expect(d.update(10)).toBeNull();
  });

  it('time before start or non-finite time is clamped to step 0 (no NaN propagation)', () => {
    const d = createDirector();
    d.start(1000);
    expect(d.update(500)?.persona).toBe('portrait');
    expect(d.update(Number.NaN)?.persona).toBe('portrait');
    d.start(Number.NaN);
    expect(d.update(100)).not.toBeNull();
  });

  it('does not mutate the supplied sequence', () => {
    const seq: DirectorStep[] = [{ base: 'live', persona: 'portrait', durationMs: 10 }];
    const snapshot = JSON.stringify(seq);
    const d = createDirector(seq);
    d.start(0);
    d.update(5);
    expect(JSON.stringify(seq)).toBe(snapshot);
  });
});
