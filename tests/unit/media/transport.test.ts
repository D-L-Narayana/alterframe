/**
 * FileSource transport (play / pause / seek / loop + onTransport events) and the frame clock's
 * rAF fallback emitting after a seek while paused. Node-side on FakeVideo; no browser.
 *
 * Latency contract: every command publishes the element's state in the SAME task (the element flips
 * `paused` / `currentTime` / `loop` synchronously), so the UI mirror never waits for the element's
 * later `play` / `pause` / `seeked` event task — which on a busy main thread queues behind the next
 * inference frame. The element events re-notify with the settled values.
 */
import { describe, it, expect } from 'vitest';
import { createFileSource, hasTransportEvents, isFileSource, type FileSource } from '@/media/fileSource';
import { createFrameClock } from '@/media/frameClock';
import type { FrameSource, TransportState } from '@/types';
import { makeEnv, FakeVideo, flush } from './fakes';

const fakeFile = () => new Blob([new Uint8Array([0, 1, 2])], { type: 'video/webm' });

async function readySource(video?: FakeVideo) {
  const h = makeEnv(video ? { video } : {});
  const src: FileSource = createFileSource(fakeFile(), h.env);
  const p = src.start();
  h.video.duration = 12;
  h.video.loadMetadata(640, 360);
  await p;
  h.video.flushEvents(); // the browser delivered the autoplay `play` event
  const events: TransportState[] = [];
  const off = src.onTransport((s) => events.push(s));
  // Object.assign keeps makeEnv's live getters (rafPending) instead of copying their current value.
  return Object.assign(h, { src, events, off });
}

const playing = (currentTime = 0): TransportState => ({ paused: false, currentTime, duration: 12, loop: true });

describe('FileSource transport', () => {
  it('exposes a FileTransport whose getters mirror the element; autoplay leaves it playing with loop on', async () => {
    const { src, video } = await readySource();
    expect(isFileSource(src)).toBe(true);
    expect(hasTransportEvents(src)).toBe(true);
    expect(src.transport.paused).toBe(false);
    expect(src.transport.currentTime).toBe(0);
    expect(src.transport.duration).toBe(12);
    expect(src.transport.loop).toBe(true);
    expect(video.loop).toBe(true);
  });

  it('pause() notifies synchronously from the command — before the element’s pause event task; that event re-notifies with the same values', async () => {
    const { src, video, events } = await readySource();
    src.transport.pause();
    expect(video.paused).toBe(true);
    expect(events).toEqual([{ paused: true, currentTime: 0, duration: 12, loop: true }]);
    expect(video.pendingEvents).toEqual(['pause']); // the element has not fired yet
    video.flushEvents();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(events[0]);
  });

  it('play() notifies synchronously right after video.play() (paused flips at once) and again when the play promise settles — never waiting for the element’s play event', async () => {
    const { src, video, events } = await readySource();
    src.transport.pause();
    events.length = 0;
    video.pendingEvents.length = 0;
    const p = src.transport.play();
    expect(video.paused).toBe(false);
    expect(events).toEqual([playing()]); // same task as the command
    await expect(p).resolves.toBe(true);
    expect(events).toHaveLength(2); // settled → re-notified with the settled values
    expect(events[1]).toEqual(playing());
    expect(video.pendingEvents).toEqual(['play']); // the element's own event is still undelivered
    video.flushEvents();
    expect(events).toHaveLength(3);
  });

  it('the FileSource play()/pause() methods are the transport commands (same synchronous mirror)', async () => {
    const { src, events } = await readySource();
    src.pause();
    expect(events).toEqual([{ paused: true, currentTime: 0, duration: 12, loop: true }]);
    const p = src.play();
    expect(events).toHaveLength(2);
    expect(events[1]?.paused).toBe(false);
    await p;
  });

  it('seek() notifies synchronously with the new position; seeked re-notifies; seeking to the same position still notifies', async () => {
    const { src, video, events } = await readySource();
    src.transport.seek(0.5);
    expect(video.currentTime).toBe(0.5);
    expect(events).toEqual([playing(0.5)]);
    video.completeSeek();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(playing(0.5));
    src.transport.seek(0.5); // no diffing in the source: deterministic, the store mirror decides
    expect(events).toHaveLength(3);
  });

  it('seek() clamps to [0, duration] and sets currentTime; each command notifies the clamped value', async () => {
    const { src, video, events } = await readySource();
    src.transport.seek(3.5);
    expect(video.currentTime).toBe(3.5);
    expect(events.at(-1)?.currentTime).toBe(3.5);
    src.transport.seek(-4);
    expect(video.currentTime).toBe(0);
    expect(events.at(-1)?.currentTime).toBe(0);
    src.transport.seek(99);
    expect(video.currentTime).toBe(12);
    expect(events.at(-1)?.currentTime).toBe(12);
    src.transport.seek(Number.NaN);
    expect(video.currentTime).toBe(0);
    expect(events).toHaveLength(4);
  });

  it('seek() before metadata only clamps at 0 (duration unknown)', () => {
    const h = makeEnv();
    const src = createFileSource(fakeFile(), h.env);
    expect(Number.isNaN(src.transport.duration)).toBe(true);
    src.transport.seek(5);
    expect(h.video.currentTime).toBe(5);
    src.transport.seek(-1);
    expect(h.video.currentTime).toBe(0);
  });

  it('setLoop() writes video.loop and notifies; an unchanged value is silent', async () => {
    const { src, video, events } = await readySource();
    src.transport.setLoop(false);
    expect(video.loop).toBe(false);
    expect(events).toEqual([{ paused: false, currentTime: 0, duration: 12, loop: false }]);
    src.transport.setLoop(false);
    expect(events).toHaveLength(1);
    src.transport.setLoop(true);
    expect(events).toHaveLength(2);
    expect(src.transport.loop).toBe(true);
  });

  it('a clip that ends with loop off stays paused; with loop on it keeps playing', async () => {
    const { src, video, events } = await readySource();
    const plays = video.playCalls;
    video.dispatch('ended'); // looping element: some browsers still fire it at the wrap
    await flush();
    expect(video.playCalls).toBe(plays + 1);
    src.transport.setLoop(false);
    video.pause(); // the element pauses itself at the end...
    video.dispatch('ended'); // ...then fires ended
    await flush();
    expect(video.playCalls).toBe(plays + 1);
    expect(video.paused).toBe(true);
    expect(events.at(-1)?.paused).toBe(true);
  });

  it('ratechange and durationchange notify too (duration becomes known late)', async () => {
    const { src, video, events } = await readySource();
    video.duration = 20;
    video.dispatch('durationchange');
    expect(events.at(-1)?.duration).toBe(20);
    expect(src.transport.duration).toBe(20);
    video.dispatch('ratechange');
    expect(events).toHaveLength(2);
  });

  it('unsubscribe stops delivery; stop() removes the element listeners and drops remaining subscribers', async () => {
    const { src, video, events, off } = await readySource();
    off();
    src.transport.pause();
    expect(events).toHaveLength(0);
    const more: TransportState[] = [];
    src.onTransport((s) => more.push(s));
    expect(video.listenerCount('play')).toBe(1);
    expect(video.listenerCount('seeked')).toBe(1);
    src.stop();
    expect(video.listenerCount('play')).toBe(0);
    expect(video.listenerCount('pause')).toBe(0);
    expect(video.listenerCount('seeked')).toBe(0);
    expect(video.listenerCount('durationchange')).toBe(0);
    expect(video.listenerCount('ratechange')).toBe(0);
    expect(video.listenerCount('ended')).toBe(0);
    more.length = 0;
    video.dispatch('play');
    expect(more).toEqual([]);
  });

  it('commands after stop() neither throw nor notify — not even listeners added afterwards', async () => {
    const { src, video, events } = await readySource();
    src.stop();
    const late: TransportState[] = [];
    src.onTransport((s) => late.push(s));
    expect(() => src.transport.pause()).not.toThrow();
    expect(() => src.transport.seek(2)).not.toThrow();
    expect(() => src.transport.setLoop(false)).not.toThrow();
    await expect(src.transport.play()).resolves.toBe(false);
    video.flushEvents();
    video.completeSeek();
    expect(events).toEqual([]);
    expect(late).toEqual([]);
  });

  it('a URL source restarted after stop() notifies again (element listeners re-attached)', async () => {
    const h = makeEnv();
    const src = createFileSource('/fixtures/hands.webm', h.env);
    let p = src.start();
    h.video.duration = 2;
    h.video.loadMetadata(320, 180);
    await p;
    src.stop();
    p = src.start();
    h.video.loadMetadata(320, 180);
    await p;
    const events: TransportState[] = [];
    src.onTransport((s) => events.push(s));
    src.transport.pause();
    expect(events).toHaveLength(1);
    h.video.flushEvents();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(h.video.listenerCount('pause')).toBe(1);
  });

  it('hasTransportEvents is false for a source without a transport', () => {
    const plain: FrameSource = { kind: 'camera', video: new FakeVideo() as unknown as HTMLVideoElement, status: 'idle', width: 0, height: 0, facingMode: 'user', start: () => Promise.resolve(), stop: () => {}, onFrame: () => () => {} };
    expect(hasTransportEvents(plain)).toBe(false);
  });
});

describe('frame clock rAF fallback (no requestVideoFrameCallback)', () => {
  it('emits the current frame once while paused, then only when currentTime changes (seek while paused)', async () => {
    const video = new FakeVideo(false);
    const h = await readySource(video);
    const { src, flushRaf } = h;
    const frames: number[] = [];
    src.onFrame((t) => frames.push(t));
    expect(h.rafPending).toBe(1);
    video.readyState = 4;
    src.transport.pause();
    flushRaf(10); // first frame of a paused clip is still shown once
    expect(frames).toEqual([10]);
    flushRaf(20);
    flushRaf(30); // paused, nothing changed → no spin
    expect(frames).toEqual([10]);
    src.transport.seek(2);
    flushRaf(40);
    expect(frames).toEqual([10, 40]);
    flushRaf(50);
    expect(frames).toEqual([10, 40]);
    src.transport.seek(2); // same position → no new frame
    flushRaf(60);
    expect(frames).toEqual([10, 40]);
    src.transport.seek(4);
    flushRaf(70);
    expect(frames).toEqual([10, 40, 70]);
  });

  it('createFrameClock: a paused element below HAVE_CURRENT_DATA never emits', () => {
    const video = new FakeVideo(false);
    const h = makeEnv({ video });
    const clock = createFrameClock(video as unknown as HTMLVideoElement, h.env);
    const frames: number[] = [];
    clock.subscribe((t) => frames.push(t));
    clock.start();
    video.readyState = 1;
    video.currentTime = 3;
    h.flushRaf(10);
    expect(frames).toEqual([]);
    video.readyState = 2;
    h.flushRaf(20);
    expect(frames).toEqual([20]);
    clock.stop();
  });
});
