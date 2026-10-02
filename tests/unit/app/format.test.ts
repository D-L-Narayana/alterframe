import { describe, it, expect } from 'vitest';
import { formatElapsed, captureFilename, mapSourceError } from '@/app/format';

describe('formatElapsed', () => {
  it('formats mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(999)).toBe('00:00');
    expect(formatElapsed(61_000)).toBe('01:01');
    expect(formatElapsed(3_599_000)).toBe('59:59');
    expect(formatElapsed(3_600_000)).toBe('60:00');
  });
});

describe('captureFilename', () => {
  it('builds alterframe-YYYYMMDD-HHMMSS.ext', () => {
    const d = new Date(2026, 9, 2, 8, 5, 9);
    expect(captureFilename('png', d)).toBe('alterframe-20261002-080509.png');
    expect(captureFilename('video/webm;codecs=vp9', d)).toBe('alterframe-20261002-080509.webm');
    expect(captureFilename('video/mp4;codecs=avc1', d)).toBe('alterframe-20261002-080509.mp4');
  });
});

describe('mapSourceError', () => {
  it('maps DOMException names to statuses', () => {
    expect(mapSourceError({ name: 'NotAllowedError' }).status).toBe('denied');
    expect(mapSourceError({ name: 'SecurityError' }).status).toBe('denied');
    expect(mapSourceError({ name: 'NotFoundError' }).status).toBe('unavailable');
    expect(mapSourceError({ name: 'OverconstrainedError' }).status).toBe('unavailable');
    expect(mapSourceError({ name: 'NotReadableError' }).status).toBe('error');
    expect(mapSourceError(new Error('boom')).status).toBe('error');
    expect(mapSourceError(new Error('boom')).message).toContain('boom');
    expect(mapSourceError(undefined).message.length).toBeGreaterThan(0);
  });
});

describe('mapSourceError with pre-classified errors', () => {
  it('passes through a status-carrying error (W2 MediaSourceError shape)', () => {
    const err = Object.assign(new Error('Camera busy'), { status: 'unavailable' });
    expect(mapSourceError(err)).toEqual({ status: 'unavailable', message: 'Camera busy' });
  });
});
