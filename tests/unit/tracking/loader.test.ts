import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCache, ProgressAggregator, MODEL_SPECS, joinUrl } from '../../../src/tracking/loader';

afterEach(() => vi.unstubAllGlobals());

describe('joinUrl', () => {
  it('joins without duplicate slashes', () => {
    expect(joinUrl('/models/', 'a.task')).toBe('/models/a.task');
    expect(joinUrl('/models', 'a.task')).toBe('/models/a.task');
    expect(joinUrl('https://x.test/m//', 'a.task')).toBe('https://x.test/m/a.task');
  });
});

describe('ProgressAggregator', () => {
  it('starts at 0, is monotonic and ends at 1', () => {
    const seen: number[] = [];
    const p = new ProgressAggregator((v) => seen.push(v), MODEL_SPECS, 3);
    p.wasmReady();
    p.bytes('hands', 4_000_000, 7_819_105);
    p.bytes('face', 3_758_596, 3_758_596);
    p.bytes('hands', 7_819_105, 7_819_105);
    p.bytes('segmentation', 249_537, 249_537);
    p.initStep(); p.initStep(); p.initStep();
    p.done();
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    // Bytes dominate the bar: after all bytes but before init, progress is ~0.9.
  });

  it('weights by bytes, so the 7.8 MB hand model moves the bar most', () => {
    const seen: number[] = [];
    const p = new ProgressAggregator((v) => seen.push(v), MODEL_SPECS, 3);
    p.wasmReady();
    const afterWasm = seen[seen.length - 1]!;
    p.bytes('segmentation', 249_537, 249_537);
    const afterSeg = seen[seen.length - 1]!;
    p.bytes('hands', 7_819_105, 7_819_105);
    const afterHands = seen[seen.length - 1]!;
    expect(afterSeg - afterWasm).toBeLessThan(0.05);
    expect(afterHands - afterSeg).toBeGreaterThan(0.4);
  });

  it('never reports a decrease when a server content-length is larger than expected', () => {
    const seen: number[] = [];
    const p = new ProgressAggregator((v) => seen.push(v), MODEL_SPECS, 1);
    p.bytes('hands', 7_000_000, 7_819_105);
    p.bytes('hands', 7_000_000, 9_000_000); // total revised upward → ratio drops → suppressed
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });
});

describe('ModelCache', () => {
  function stream(bytes: number, chunks = 4): Response {
    const data = new Uint8Array(bytes).map((_, i) => i & 0xff);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= bytes) { c.close(); return; }
        const n = Math.min(Math.ceil(bytes / chunks), bytes - sent);
        c.enqueue(data.subarray(sent, sent + n));
        sent += n;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-length': String(bytes) } });
  }

  it('streams the bytes, reports progress, and caches by URL', async () => {
    const fetchMock = vi.fn(async () => stream(1000));
    vi.stubGlobal('fetch', fetchMock);
    const cache = new ModelCache();
    const progress: [number, number][] = [];
    const a = await cache.load('/models/x.task', 1000, (l, t) => progress.push([l, t]));
    expect(a.byteLength).toBe(1000);
    expect(a[5]).toBe(5);
    expect(progress[progress.length - 1]).toEqual([1000, 1000]);
    expect(progress.length).toBeGreaterThan(2);
    const b = await cache.load('/models/x.task', 1000);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws a readable error on HTTP failure and allows a retry', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (n++ === 0 ? new Response(null, { status: 404 }) : stream(10))));
    const cache = new ModelCache();
    await expect(cache.load('/models/missing.task', 10)).rejects.toThrow(/missing\.task.*404/);
    const ok = await cache.load('/models/missing.task', 10);
    expect(ok.byteLength).toBe(10);
  });

  it('falls back to the expected size when content-length is missing', async () => {
    const data = new Uint8Array(50);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([data]).stream(), { status: 200 })));
    const cache = new ModelCache();
    const totals = new Set<number>();
    await cache.load('/models/y.task', 50, (_l, t) => totals.add(t));
    expect(totals.has(50)).toBe(true);
  });
});
