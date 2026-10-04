import { describe, it, expect } from 'vitest';
import { formatElapsed, formatSeconds, captureFilename, extensionForMime, mapSourceError } from '@/app/format';

describe('formatElapsed', () => {
  it('formats mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(999)).toBe('00:00');
    expect(formatElapsed(61_000)).toBe('01:01');
    expect(formatElapsed(3_599_000)).toBe('59:59');
    expect(formatElapsed(3_600_000)).toBe('60:00');
  });
});

describe('formatSeconds (media currentTime → mm:ss for the seek slider)', () => {
  it('formats seconds and tolerates NaN/∞ (duration unknown before metadata)', () => {
    expect(formatSeconds(0)).toBe('00:00');
    expect(formatSeconds(65.4)).toBe('01:05');
    expect(formatSeconds(Number.NaN)).toBe('00:00');
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBe('00:00');
    expect(formatSeconds(-3)).toBe('00:00');
  });
});

describe('captureFilename', () => {
  it('builds alterframe-YYYYMMDD-HHMMSS.ext', () => {
    const d = new Date(2026, 9, 2, 8, 5, 9);
    expect(captureFilename('png', d)).toBe('alterframe-20261002-080509.png');
    expect(captureFilename('video/webm;codecs=vp9', d)).toBe('alterframe-20261002-080509.webm');
    expect(captureFilename('video/mp4;codecs=avc1', d)).toBe('alterframe-20261002-080509.mp4');
  });

  it('derives jpg / webp / png from the snapshot blob type', () => {
    const d = new Date(2026, 9, 2, 8, 5, 9);
    expect(captureFilename('image/jpeg', d)).toBe('alterframe-20261002-080509.jpg');
    expect(captureFilename('image/webp', d)).toBe('alterframe-20261002-080509.webp');
    expect(captureFilename('image/png', d)).toBe('alterframe-20261002-080509.png');
    // Unknown / empty blob types fall back to PNG (what the encoder produces when it cannot honour the request).
    expect(captureFilename('image/bmp', d)).toBe('alterframe-20261002-080509.png');
    expect(captureFilename('', d)).toBe('alterframe-20261002-080509.png');
    expect(captureFilename('jpg', d)).toBe('alterframe-20261002-080509.jpg');
  });

  it('extensionForMime ignores codec parameters and case', () => {
    expect(extensionForMime('image/JPEG')).toBe('jpg');
    expect(extensionForMime('image/webp')).toBe('webp');
    expect(extensionForMime('video/webm;codecs=vp8')).toBe('webm');
    expect(extensionForMime('video/mp4')).toBe('mp4');
    expect(extensionForMime('application/octet-stream')).toBe('webm');
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
  it('passes through a status-carrying error (media MediaSourceError shape)', () => {
    const err = Object.assign(new Error('Camera busy'), { status: 'unavailable' });
    expect(mapSourceError(err)).toEqual({ status: 'unavailable', message: 'Camera busy' });
  });
});
