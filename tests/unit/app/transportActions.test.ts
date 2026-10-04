/** File-transport keyboard actions (P / [ / ] / L): pure, no DOM. */
import { describe, it, expect, vi } from 'vitest';
import type { FileTransport } from '@/types';
import { createTransportActions } from '@/app/transportActions';

function fakeTransport(init: Partial<{ paused: boolean; currentTime: number; duration: number; loop: boolean; playResult: boolean }> = {}) {
  const calls: string[] = [];
  const t = {
    paused: init.paused ?? true,
    currentTime: init.currentTime ?? 5,
    duration: init.duration ?? 20,
    loop: init.loop ?? true,
    play: vi.fn(async () => {
      calls.push('play');
      if (init.playResult === false) return false;
      t.paused = false;
      return true;
    }),
    pause: vi.fn(() => {
      calls.push('pause');
      t.paused = true;
    }),
    seek: vi.fn((s: number) => {
      calls.push(`seek:${s}`);
      t.currentTime = Math.min(t.duration, Math.max(0, s));
    }),
    setLoop: vi.fn((v: boolean) => {
      calls.push(`loop:${v}`);
      t.loop = v;
    }),
  } satisfies FileTransport & Record<string, unknown>;
  return { t, calls };
}

describe('createTransportActions', () => {
  it('is a silent no-op for every key when there is no transport (camera sources)', () => {
    const notify = vi.fn();
    const a = createTransportActions({ getTransport: () => null, notify });
    a.togglePlayback();
    a.seekBy(1);
    a.seekBy(-1);
    a.toggleLoop();
    expect(notify).not.toHaveBeenCalled();
  });

  it('P toggles play/pause', async () => {
    const { t, calls } = fakeTransport({ paused: true });
    const a = createTransportActions({ getTransport: () => t, notify: vi.fn() });
    a.togglePlayback();
    await Promise.resolve();
    expect(calls).toEqual(['play']);
    a.togglePlayback();
    expect(calls).toEqual(['play', 'pause']);
  });

  it('reports a blocked play() (autoplay policy) as an error toast', async () => {
    const { t } = fakeTransport({ paused: true, playResult: false });
    const notify = vi.fn();
    const a = createTransportActions({ getTransport: () => t, notify });
    a.togglePlayback();
    await Promise.resolve();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/blocked|could not/i), 'error');
  });

  it('[ and ] seek relative to the current time, clamped to the clip', () => {
    const { t, calls } = fakeTransport({ currentTime: 0.5, duration: 20 });
    const a = createTransportActions({ getTransport: () => t, notify: vi.fn() });
    a.seekBy(-1);
    expect(calls).toEqual(['seek:0']);
    a.seekBy(1);
    expect(calls).toEqual(['seek:0', 'seek:1']);
    t.currentTime = 19.7;
    a.seekBy(1);
    expect(calls[2]).toBe('seek:20');
  });

  it('tolerates an unknown duration (NaN before metadata)', () => {
    const { t, calls } = fakeTransport({ currentTime: 2, duration: Number.NaN });
    const a = createTransportActions({ getTransport: () => t, notify: vi.fn() });
    a.seekBy(1);
    expect(calls).toEqual(['seek:3']);
  });

  it('L toggles loop and announces it', () => {
    const { t, calls } = fakeTransport({ loop: true });
    const notify = vi.fn();
    const a = createTransportActions({ getTransport: () => t, notify });
    a.toggleLoop();
    expect(calls).toEqual(['loop:false']);
    expect(notify).toHaveBeenLastCalledWith('Loop off');
    a.toggleLoop();
    expect(calls).toEqual(['loop:false', 'loop:true']);
    expect(notify).toHaveBeenLastCalledWith('Loop on');
  });
});
