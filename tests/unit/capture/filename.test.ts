import { describe, it, expect } from 'vitest';
import { captureFilename, extensionForMime } from '@/capture/filename';

describe('captureFilename', () => {
  it('formats alterframe-YYYYMMDD-HHMMSS.ext in local time with zero padding', () => {
    const d = new Date(2026, 0, 5, 7, 8, 9); // Jan 5 2026 07:08:09 local
    expect(captureFilename('png', d)).toBe('alterframe-20260105-070809.png');
    expect(captureFilename('webm', d)).toBe('alterframe-20260105-070809.webm');
    expect(captureFilename('mp4', d)).toBe('alterframe-20260105-070809.mp4');
  });

  it('matches the contract regex for any date', () => {
    const name = captureFilename('webm', new Date(2031, 11, 31, 23, 59, 59));
    expect(name).toMatch(/^alterframe-\d{8}-\d{6}\.(webm|mp4|png|jpg|webp)$/);
    expect(name).toBe('alterframe-20311231-235959.webm');
  });

  it('accepts the lossy snapshot extensions jpg and webp', () => {
    const d = new Date(2026, 0, 5, 7, 8, 9);
    expect(captureFilename('jpg', d)).toBe('alterframe-20260105-070809.jpg');
    expect(captureFilename('webp', d)).toBe('alterframe-20260105-070809.webp');
  });
});

describe('extensionForMime', () => {
  it('maps container mime types to extensions, ignoring codec params', () => {
    expect(extensionForMime('video/mp4;codecs=avc1')).toBe('mp4');
    expect(extensionForMime('video/webm;codecs=vp9')).toBe('webm');
    expect(extensionForMime('video/webm')).toBe('webm');
    expect(extensionForMime('image/png')).toBe('png');
  });
  it('maps the snapshot image types: image/jpeg → jpg, image/webp → webp (case-insensitive, parameters ignored)', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/webp')).toBe('webp');
    expect(extensionForMime('IMAGE/JPEG')).toBe('jpg');
    expect(extensionForMime('image/webp; charset=binary')).toBe('webp');
  });
  it('round-trips a snapshot Blob type into a filename', () => {
    const d = new Date(2026, 0, 5, 7, 8, 9);
    expect(captureFilename(extensionForMime(new Blob([], { type: 'image/jpeg' }).type), d)).toBe('alterframe-20260105-070809.jpg');
    expect(captureFilename(extensionForMime(new Blob([], { type: 'image/webp' }).type), d)).toBe('alterframe-20260105-070809.webp');
    expect(captureFilename(extensionForMime(new Blob([], { type: 'image/png' }).type), d)).toBe('alterframe-20260105-070809.png');
  });
  it('falls back to webm for unknown video mimes', () => {
    expect(extensionForMime('video/x-matroska')).toBe('webm');
    expect(extensionForMime('')).toBe('webm');
  });
});
