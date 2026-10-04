import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { snapshot, download } from '@/capture/snapshot';
import type { CanvasLike } from '@/capture/recorder';

interface FakeSnapCanvas extends CanvasLike {
  calls: unknown[][];
  toBlob?: (cb: (b: Blob | null) => void, type?: string, quality?: number) => void;
  convertToBlob?: (opts?: { type?: string; quality?: number }) => Promise<Blob>;
  /** Arguments of the LAST toBlob call: [type, quality]. */
  toBlobArgs: unknown[];
  /** Arguments of every toBlob call, in order. */
  toBlobCalls: unknown[][];
}

/** Fake encoder: by default echoes the requested type (a browser that supports every format). */
type Encoder = (type: string | undefined) => Blob | null;
const echo: Encoder = (type) => new Blob(['img'], { type: type ?? '' });

function fakeCanvas(w: number, h: number, encode: Encoder = echo): FakeSnapCanvas {
  const c: FakeSnapCanvas = {
    width: w,
    height: h,
    calls: [],
    toBlobArgs: [],
    toBlobCalls: [],
    getContext: () => ({
      drawImage: (...args: unknown[]) => c.calls.push(args),
    }),
    toBlob: (cb, type, quality) => {
      c.toBlobArgs = [type, quality];
      c.toBlobCalls.push([type, quality]);
      cb(encode(type));
    },
  };
  return c;
}

/** `createCanvas` dep that records every intermediate canvas it hands out. */
function collecting(encode: Encoder = echo) {
  const created: FakeSnapCanvas[] = [];
  const createCanvas = (w: number, h: number) => {
    const c = fakeCanvas(w, h, encode);
    created.push(c);
    return c;
  };
  return { created, createCanvas };
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
      snapshot(source as unknown as HTMLCanvasElement, '16:9', { createCanvas: (w, h) => fakeCanvas(w, h, () => null) }),
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

describe('snapshot — formats', () => {
  const source = () => fakeCanvas(1280, 720) as unknown as HTMLCanvasElement;

  it('defaults to PNG and passes no quality for the lossless format', async () => {
    const { created, createCanvas } = collecting();
    const blob = await snapshot(source(), 'source', { createCanvas });
    expect(created[0]!.toBlobCalls).toEqual([['image/png', undefined]]);
    expect(blob.type).toBe('image/png');
  });

  it('format "png" with a quality still encodes PNG without a quality argument', async () => {
    const { created, createCanvas } = collecting();
    await snapshot(source(), 'source', { format: 'png', quality: 0.5, createCanvas });
    expect(created[0]!.toBlobCalls).toEqual([['image/png', undefined]]);
  });

  it('format "jpeg" requests image/jpeg with the given quality; the Blob type reports the real format', async () => {
    const { created, createCanvas } = collecting();
    const blob = await snapshot(source(), 'source', { format: 'jpeg', quality: 0.8, createCanvas });
    expect(created[0]!.toBlobCalls).toEqual([['image/jpeg', 0.8]]);
    expect(blob.type).toBe('image/jpeg');
    expect(created[0]!.width).toBe(0); // released
  });

  it('format "webp" requests image/webp with the default quality 0.92 and keeps the crop math', async () => {
    const { created, createCanvas } = collecting();
    const src = source();
    const blob = await snapshot(src, '1:1', { format: 'webp', createCanvas });
    expect(created[0]!.toBlobCalls).toEqual([['image/webp', 0.92]]);
    expect(blob.type).toBe('image/webp');
    expect(created[0]!.calls).toEqual([[src, 280, 0, 720, 720, 0, 0, 1080, 1080]]);
  });

  it('clamps the quality into 0..1 and ignores NaN', async () => {
    for (const [given, expected] of [
      [1.7, 1],
      [-3, 0],
      [NaN, 0.92],
    ] as const) {
      const { created, createCanvas } = collecting();
      await snapshot(source(), 'source', { format: 'jpeg', quality: given, createCanvas });
      expect(created[0]!.toBlobCalls, `quality ${given}`).toEqual([['image/jpeg', expected]]);
    }
  });

  it('falls back to PNG transparently when the browser returns a PNG for an unsupported type (no second encode)', async () => {
    // Chromium/Safari behaviour for unsupported encoders: toBlob yields a PNG regardless of the requested type.
    const pngOnly: Encoder = () => new Blob(['png'], { type: 'image/png' });
    const { created, createCanvas } = collecting(pngOnly);
    const blob = await snapshot(source(), 'source', { format: 'webp', quality: 0.7, createCanvas });
    expect(blob.type).toBe('image/png');
    expect(created[0]!.toBlobCalls).toEqual([['image/webp', 0.7]]);
    expect(created[0]!.width).toBe(0);
  });

  it('re-encodes as PNG when the browser returns yet another type', async () => {
    const odd: Encoder = (type) => (type === 'image/png' ? new Blob(['png'], { type: 'image/png' }) : new Blob(['x'], { type: 'image/bmp' }));
    const { created, createCanvas } = collecting(odd);
    const blob = await snapshot(source(), 'source', { format: 'jpeg', quality: 0.6, createCanvas });
    expect(blob.type).toBe('image/png');
    expect(created[0]!.toBlobCalls).toEqual([
      ['image/jpeg', 0.6],
      ['image/png', undefined],
    ]);
    expect(created[0]!.width).toBe(0);
  });

  it('re-encodes as PNG when the lossy encoder returns null or an empty blob', async () => {
    const lossyBroken: Encoder = (type) => (type === 'image/png' ? new Blob(['png'], { type: 'image/png' }) : null);
    const { created, createCanvas } = collecting(lossyBroken);
    const blob = await snapshot(source(), 'source', { format: 'jpeg', createCanvas });
    expect(blob.type).toBe('image/png');
    expect(created[0]!.toBlobCalls).toEqual([
      ['image/jpeg', 0.92],
      ['image/png', undefined],
    ]);
  });

  it('rejects readably (naming the requested format) when even the PNG fallback fails', async () => {
    const { createCanvas } = collecting(() => null);
    await expect(snapshot(source(), 'source', { format: 'jpeg', createCanvas })).rejects.toThrow(/could not encode the snapshot as JPEG/i);
  });

  it('uses convertToBlob({ type, quality }) on canvases without toBlob (OffscreenCanvas)', async () => {
    const convertCalls: unknown[] = [];
    const createCanvas = (w: number, h: number) => {
      const c = fakeCanvas(w, h);
      delete c.toBlob;
      c.convertToBlob = (opts) => {
        convertCalls.push(opts);
        return Promise.resolve(new Blob(['img'], { type: opts?.type ?? '' }));
      };
      return c;
    };
    const blob = await snapshot(source(), 'source', { format: 'webp', quality: 0.5, createCanvas });
    expect(convertCalls).toEqual([{ type: 'image/webp', quality: 0.5 }]);
    expect(blob.type).toBe('image/webp');
    const png = await snapshot(source(), 'source', { createCanvas });
    expect(convertCalls[1]).toEqual({ type: 'image/png' });
    expect(png.type).toBe('image/png');
  });

  it('convertToBlob: falls back to PNG when the engine returns a different type, and reports engine errors readably', async () => {
    const createCanvas = (w: number, h: number) => {
      const c = fakeCanvas(w, h);
      delete c.toBlob;
      c.convertToBlob = (opts) => (opts?.type === 'image/png' ? Promise.resolve(new Blob(['png'], { type: 'image/png' })) : Promise.resolve(new Blob(['x'], { type: 'image/bmp' })));
      return c;
    };
    const blob = await snapshot(source(), 'source', { format: 'jpeg', createCanvas });
    expect(blob.type).toBe('image/png');
    const failing = (w: number, h: number) => {
      const c = fakeCanvas(w, h);
      delete c.toBlob;
      c.convertToBlob = () => Promise.reject(new DOMException('encoding failed', 'EncodingError'));
      return c;
    };
    await expect(snapshot(source(), 'source', { format: 'webp', createCanvas: failing })).rejects.toThrow(/could not encode the snapshot as WebP.*encoding failed/i);
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
