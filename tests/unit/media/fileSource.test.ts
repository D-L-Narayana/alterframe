import { describe, it, expect } from 'vitest';
import { createFileSource, describeMediaError } from '@/media/fileSource';
import { MediaSourceError } from '@/media/errors';
import type { SourceStatus } from '@/types';
import { makeEnv, flush } from './fakes';

const fakeFile = () => new Blob([new Uint8Array([0, 1, 2])], { type: 'video/webm' });

describe('createFileSource', () => {
  it('creates an object URL, configures loop/muted/inline, and is ready on loadedmetadata', async () => {
    const h = makeEnv();
    const src = createFileSource(fakeFile(), h.env);
    const statuses: SourceStatus[] = [];
    src.onStatus((s) => statuses.push(s));
    expect(src.url).toMatch(/^blob:fake\//);
    expect(src.kind).toBe('file');
    expect(src.facingMode).toBe('user');
    const p = src.start();
    expect(src.status).toBe('requesting');
    expect(h.video.src).toBe(src.url);
    expect(h.video.loop).toBe(true);
    expect(h.video.muted).toBe(true);
    expect(h.video.playsInline).toBe(true);
    expect(h.video.loadCalls).toBe(1);
    h.video.loadMetadata(1920, 1080);
    await p;
    expect(statuses).toEqual(['requesting', 'ready']);
    expect(src.width).toBe(1920);
    expect(src.height).toBe(1080);
    expect(h.video.playCalls).toBe(1);
    expect(src.paused).toBe(false);
  });

  it('accepts a URL string without creating an object URL', () => {
    const h = makeEnv();
    const src = createFileSource('/fixtures/hands.webm', h.env);
    expect(src.url).toBe('/fixtures/hands.webm');
    src.stop();
    expect(h.revoked).toEqual([]);
  });

  it('media element error → status error with readable message', async () => {
    const h = makeEnv();
    const src = createFileSource(fakeFile(), h.env);
    const p = src.start();
    h.video.error = { code: 4 };
    h.video.dispatch('error');
    await expect(p).rejects.toBeInstanceOf(MediaSourceError);
    expect(src.status).toBe('error');
    expect(src.error).toMatch(/not supported/i);
  });

  it('audio-only file (0x0) → error', async () => {
    const h = makeEnv();
    const src = createFileSource(fakeFile(), h.env);
    const p = src.start();
    h.video.loadMetadata(0, 0);
    await expect(p).rejects.toMatchObject({ status: 'error' });
  });

  it('stop() cancels frame callbacks, detaches src, revokes the object URL, and blocks restart', async () => {
    const h = makeEnv();
    const src = createFileSource(fakeFile(), h.env);
    const p = src.start();
    h.video.loadMetadata(640, 360);
    await p;
    src.onFrame(() => {});
    expect(h.video.rvfcCallbacks.size).toBe(1);
    expect(h.doc.listenerCount('visibilitychange')).toBe(1);
    src.stop();
    expect(h.video.rvfcCallbacks.size).toBe(0);
    expect(h.video.paused).toBe(true);
    expect(h.video.src).toBe('');
    expect(h.revoked).toEqual([src.url]);
    expect(h.doc.listenerCount('visibilitychange')).toBe(0);
    expect(src.status).toBe('idle');
    await expect(src.start()).rejects.toMatchObject({ status: 'error' });
  });

  it('frames flow through onFrame once ready', async () => {
    const h = makeEnv();
    const src = createFileSource(fakeFile(), h.env);
    const p = src.start();
    h.video.loadMetadata(640, 360);
    await p;
    const seen: number[] = [];
    src.onFrame((t) => seen.push(t));
    h.video.presentFrame(100, 1);
    h.video.presentFrame(133, 2);
    expect(seen).toEqual([100, 133]);
  });

  it('visibility: pauses only when it was playing, resumes afterwards', async () => {
    const h = makeEnv();
    const src = createFileSource(fakeFile(), h.env);
    const p = src.start();
    h.video.loadMetadata(640, 360);
    await p;
    h.doc.visibilityState = 'hidden';
    h.doc.dispatch('visibilitychange');
    expect(h.video.paused).toBe(true);
    h.doc.visibilityState = 'visible';
    h.doc.dispatch('visibilitychange');
    await flush();
    expect(h.video.paused).toBe(false);
  });

  it('describeMediaError covers all MediaError codes', () => {
    expect(describeMediaError(1)).toMatch(/aborted/);
    expect(describeMediaError(2)).toMatch(/network/);
    expect(describeMediaError(3)).toMatch(/decoded/);
    expect(describeMediaError(4)).toMatch(/format/);
    expect(describeMediaError(undefined)).toMatch(/could not be loaded/);
  });
});
