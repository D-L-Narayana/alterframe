import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { snapshot, download } from '@/capture/snapshot';
import type { CanvasLike } from '@/capture/recorder';

interface FakeSnapCanvas extends CanvasLike {
  calls: unknown[][];
  toBlob?: (cb: (b: Blob | null) => void, type?: string, quality?: number) => void;
  toBlobArgs: unknown[];
}

function fakeCanvas(w: number, h: number, blob: Blob | null = new Blob(['png'], { type: 'image/png' })): FakeSnapCanvas {
  const c: FakeSnapCanvas = {
    width: w,
    height: h,
    calls: [],
    toBlobArgs: [],
    getContext: () => ({
      drawImage: (...args: unknown[]) => c.calls.push(args),
    }),
    toBlob: (cb, type, quality) => {
      c.toBlobArgs = [type, quality];
      cb(blob);
    },
  };
  return c;
}

describe('snapshot', () => {
  it('draws the centre crop into a fresh canvas of the output size and encodes PNG', async () => {
    const source = fakeCanvas(1280, 720);
    const created: FakeSnapCanvas[] = [];
    const sizes: Array<[number, number]> = [];
    const blob = await snapshot(source as unknown as HTMLCanvasElement, '1:1', {
      createCanvas: (w, h) => {
        sizes.push([w, h]);
        const c = fakeCanvas(w, h);
        created.push(c);
        return c;
      },
    });
    expect(created).toHaveLength(1);
    expect(sizes).toEqual([[1080, 1080]]);
    expect(created[0]!.calls).toEqual([[source, 280, 0, 720, 720, 0, 0, 1080, 1080]]);
    expect(created[0]!.toBlobArgs[0]).toBe('image/png');
    expect(blob.type).toBe('image/png');
    // intermediate canvas released
    expect(created[0]!.width).toBe(0);
  });

  it('source aspect copies the even-rounded full frame 1:1', async () => {
    const source = fakeCanvas(1281, 719);
    const created: FakeSnapCanvas[] = [];
    await snapshot(source as unknown as HTMLCanvasElement, 'source', {
      createCanvas: (w, h) => {
        const c = fakeCanvas(w, h);
        created.push(c);
        return c;
      },
    });
    expect(created[0]!.calls).toEqual([[source, 0, 0, 1280, 718, 0, 0, 1280, 718]]);
  });

  it('rejects readably when the encoder returns null', async () => {
    const source = fakeCanvas(640, 360);
    await expect(
      snapshot(source as unknown as HTMLCanvasElement, '16:9', { createCanvas: (w, h) => fakeCanvas(w, h, null) }),
    ).rejects.toThrow(/could not encode/i);
  });

  it('rejects readably on an empty canvas', async () => {
    const source = fakeCanvas(0, 0);
    await expect(snapshot(source as unknown as HTMLCanvasElement, '9:16', { createCanvas: (w, h) => fakeCanvas(w, h) })).rejects.toThrow(
      /empty|zero/i,
    );
  });

  it('rejects when the canvas has no PNG encoder at all', async () => {
    const source = fakeCanvas(640, 360);
    await expect(
      snapshot(source as unknown as HTMLCanvasElement, '16:9', {
        createCanvas: (w, h) => {
          const c = fakeCanvas(w, h);
          delete c.toBlob;
          return c;
        },
      }),
    ).rejects.toThrow(/toBlob/i);
  });
});

describe('download', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates an object URL, clicks a hidden anchor with the filename, then revokes the URL', () => {
    const anchor = { href: '', download: '', rel: '', style: { display: '' }, click: vi.fn(), remove: vi.fn() };
    const appended: unknown[] = [];
    const doc = {
      createElement: vi.fn(() => anchor),
      body: { appendChild: (n: unknown) => appended.push(n) },
    };
    const url = { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() };
    const blob = new Blob(['x']);
    download(blob, 'alterframe-20260102-101010.webm', { document: doc, URL: url, revokeDelayMs: 1000 });
    expect(url.createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchor.href).toBe('blob:fake');
    expect(anchor.download).toBe('alterframe-20260102-101010.webm');
    expect(appended).toEqual([anchor]);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    expect(url.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(url.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});
