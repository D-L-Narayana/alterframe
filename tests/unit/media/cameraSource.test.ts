import { describe, it, expect, vi } from 'vitest';
import { createCameraSource, buildCameraConstraints } from '@/media/cameraSource';
import { MediaSourceError, classifyGetUserMediaError } from '@/media/errors';
import type { SourceStatus } from '@/types';
import { makeEnv, FakeStream, FakeTrack, FakeVideo, domError, flush } from './fakes';

/** Start a source whose fake browser grants permission; drives metadata so start() settles. */
async function startGranted(opts: Parameters<typeof makeEnv>[0] = {}, camOpts = {}) {
  const track = new FakeTrack({ deviceId: 'cam-1', facingMode: 'user', width: 1280, height: 720 });
  const h = makeEnv({ getUserMedia: () => Promise.resolve(new FakeStream([track]) as unknown as MediaStream), ...opts });
  const src = createCameraSource(camOpts, h.env);
  const statuses: SourceStatus[] = [];
  src.onStatus((s) => statuses.push(s));
  const p = src.start();
  await flush();
  expect(h.video.srcObject).not.toBeNull();
  h.video.loadMetadata(1280, 720);
  await p;
  return Object.assign(h, { src, track, statuses });
}

describe('buildCameraConstraints', () => {
  it('uses ideal 1280x720@30 by default and no audio', () => {
    const c = buildCameraConstraints({});
    expect(c.audio).toBe(false);
    expect(c.video).toEqual({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
  });
  it('prefers exact deviceId over facingMode, relaxes to facingMode on retry', () => {
    const strict = buildCameraConstraints({ deviceId: 'abc', facingMode: 'environment' });
    expect((strict.video as MediaTrackConstraints).deviceId).toEqual({ exact: 'abc' });
    expect((strict.video as MediaTrackConstraints).facingMode).toBeUndefined();
    const relaxed = buildCameraConstraints({ deviceId: 'abc', facingMode: 'environment' }, true);
    expect((relaxed.video as MediaTrackConstraints).deviceId).toBeUndefined();
    expect((relaxed.video as MediaTrackConstraints).facingMode).toBe('environment');
  });
});

describe('classifyGetUserMediaError', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'unavailable'],
    ['OverconstrainedError', 'unavailable'],
    ['NotSupportedError', 'unavailable'],
    ['NotReadableError', 'error'],
    ['SomethingElse', 'error'],
  ])('%s → %s', (name, status) => {
    expect(classifyGetUserMediaError(domError(name)).status).toBe(status);
  });
  it('handles non-Error rejections', () => {
    expect(classifyGetUserMediaError('nope').status).toBe('error');
  });
});

describe('createCameraSource status machine', () => {
  it('idle → requesting → ready when granted; reports dimensions and facing', async () => {
    const { src, statuses, video } = await startGranted();
    expect(statuses).toEqual(['requesting', 'ready']);
    expect(src.status).toBe('ready');
    expect(src.width).toBe(1280);
    expect(src.height).toBe(720);
    expect(src.facingMode).toBe('user');
    expect(src.deviceId).toBe('cam-1');
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.playCalls).toBe(1);
    expect(src.error).toBeNull();
  });

  it('NotAllowedError → denied and start() rejects with MediaSourceError', async () => {
    const h = makeEnv({ getUserMedia: () => Promise.reject(domError('NotAllowedError')) });
    const src = createCameraSource({}, h.env);
    const statuses: SourceStatus[] = [];
    src.onStatus((s) => statuses.push(s));
    await expect(src.start()).rejects.toBeInstanceOf(MediaSourceError);
    expect(src.status).toBe('denied');
    expect(src.error).toMatch(/denied/i);
    expect(statuses).toEqual(['requesting', 'denied']);
  });

  it('NotFoundError → unavailable', async () => {
    const h = makeEnv({ getUserMedia: () => Promise.reject(domError('NotFoundError')) });
    const src = createCameraSource({}, h.env);
    await expect(src.start()).rejects.toMatchObject({ status: 'unavailable' });
    expect(src.status).toBe('unavailable');
  });

  it('missing mediaDevices (insecure context) → unavailable without throwing synchronously', async () => {
    const h = makeEnv({ hasMediaDevices: false });
    const src = createCameraSource({}, h.env);
    await expect(src.start()).rejects.toMatchObject({ status: 'unavailable' });
    expect(src.error).toMatch(/HTTPS/);
  });

  it('NotReadableError → error with readable message', async () => {
    const h = makeEnv({ getUserMedia: () => Promise.reject(domError('NotReadableError', 'Device in use')) });
    const src = createCameraSource({}, h.env);
    await expect(src.start()).rejects.toMatchObject({ status: 'error' });
    expect(src.error).toMatch(/busy/i);
  });

  it('retries without the exact deviceId when that device is gone', async () => {
    let calls = 0;
    const h = makeEnv({
      getUserMedia: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(domError('OverconstrainedError'))
          : Promise.resolve(new FakeStream([new FakeTrack({ deviceId: 'other' })]) as unknown as MediaStream);
      },
    });
    const src = createCameraSource({ deviceId: 'stale', facingMode: 'user' }, h.env);
    const p = src.start();
    await flush();
    h.video.loadMetadata(640, 480);
    await p;
    expect(calls).toBe(2);
    expect((h.gumCalls[1]?.video as MediaTrackConstraints).deviceId).toBeUndefined();
    expect(src.deviceId).toBe('other');
    expect(src.status).toBe('ready');
  });

  it('start() is idempotent while requesting and after ready', async () => {
    const h = makeEnv();
    const src = createCameraSource({}, h.env);
    const p1 = src.start();
    const p2 = src.start();
    expect(p1).toBe(p2);
    await flush();
    h.video.loadMetadata(320, 240);
    await p1;
    expect(h.gumCalls.length).toBe(1);
    await src.start();
    expect(h.gumCalls.length).toBe(1);
  });

  it('metadata timeout → error', async () => {
    vi.useFakeTimers();
    try {
      const h = makeEnv();
      const src = createCameraSource({}, h.env);
      const p = src.start();
      const expectation = expect(p).rejects.toMatchObject({ status: 'error' });
      await flush();
      await vi.advanceTimersByTimeAsync(9000);
      await expectation;
      expect(src.status).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createCameraSource frames and cleanup', () => {
  it('delivers frames via requestVideoFrameCallback and stop() cancels callbacks and stops tracks', async () => {
    const { src, video, track, doc } = await startGranted();
    const frames: Array<[number, number]> = [];
    const off = src.onFrame((t, m) => frames.push([t, m.presentedFrames]));
    expect(video.rvfcCallbacks.size).toBe(1);
    video.presentFrame(16, 1);
    video.presentFrame(33, 2);
    expect(frames).toEqual([
      [16, 1],
      [33, 2],
    ]);
    expect(video.rvfcCallbacks.size).toBe(1); // re-armed
    expect(doc.listenerCount('visibilitychange')).toBe(1);

    src.stop();
    expect(video.rvfcCallbacks.size).toBe(0);
    expect(track.stopped).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(src.status).toBe('idle');
    expect(src.width).toBe(0);
    expect(doc.listenerCount('visibilitychange')).toBe(0);
    expect(track.listenerCount('ended')).toBe(0);
    off();
  });

  it('unsubscribing the last listener disarms the clock', async () => {
    const { src, video } = await startGranted();
    const off = src.onFrame(() => {});
    expect(video.rvfcCallbacks.size).toBe(1);
    off();
    expect(video.rvfcCallbacks.size).toBe(0);
  });

  it('falls back to rAF polling on currentTime change when rVFC is missing', async () => {
    const video = new FakeVideo(false);
    const h = await startGranted({ video });
    const { src, flushRaf } = h;
    const frames: number[] = [];
    src.onFrame((t) => frames.push(t));
    expect(h.rafPending).toBe(1);
    video.readyState = 4;
    video.currentTime = 0.1;
    flushRaf(10);
    flushRaf(20); // same currentTime → no frame
    video.currentTime = 0.2;
    flushRaf(30);
    expect(frames).toEqual([10, 30]);
    src.stop();
    expect(h.rafPending).toBe(0);
  });

  it('device unplug (track ended) → unavailable and stream released', async () => {
    const { src, track, video } = await startGranted();
    track.dispatch('ended');
    expect(src.status).toBe('unavailable');
    expect(src.error).toMatch(/disconnected/i);
    expect(track.stopped).toBe(true);
    expect(video.srcObject).toBeNull();
  });

  it('pauses on hidden tab and resumes on visible', async () => {
    const { video, doc } = await startGranted();
    expect(video.paused).toBe(false);
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    expect(video.paused).toBe(true);
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    await flush();
    expect(video.paused).toBe(false);
    expect(video.playCalls).toBe(2);
  });

  it('stop() during the permission prompt releases the late stream and stays idle', async () => {
    const track = new FakeTrack();
    let resolveGum: ((s: MediaStream) => void) | null = null;
    const h = makeEnv({ getUserMedia: () => new Promise<MediaStream>((r) => (resolveGum = r)) });
    const src = createCameraSource({}, h.env);
    const p = src.start();
    expect(src.status).toBe('requesting');
    src.stop();
    expect(src.status).toBe('idle');
    resolveGum!(new FakeStream([track]) as unknown as MediaStream);
    await p;
    expect(track.stopped).toBe(true);
    expect(src.status).toBe('idle');
  });

  it('listDevices enumerates video inputs after permission', async () => {
    const devices = [
      { kind: 'videoinput', deviceId: 'a', label: 'Front', groupId: 'g' },
      { kind: 'audioinput', deviceId: 'm', label: 'Mic', groupId: 'g' },
    ] as MediaDeviceInfo[];
    const { src } = await startGranted({ enumerateDevices: () => Promise.resolve(devices) });
    await flush();
    const list = await src.listDevices();
    expect(list.map((d) => d.deviceId)).toEqual(['a']);
  });
});
