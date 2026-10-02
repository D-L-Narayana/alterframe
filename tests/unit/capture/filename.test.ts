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
    expect(name).toMatch(/^alterframe-\d{8}-\d{6}\.(webm|mp4|png)$/);
    expect(name).toBe('alterframe-20311231-235959.webm');
  });
});

describe('extensionForMime', () => {
  it('maps container mime types to extensions, ignoring codec params', () => {
    expect(extensionForMime('video/mp4;codecs=avc1')).toBe('mp4');
    expect(extensionForMime('video/webm;codecs=vp9')).toBe('webm');
    expect(extensionForMime('video/webm')).toBe('webm');
    expect(extensionForMime('image/png')).toBe('png');
  });
  it('falls back to webm for unknown video mimes', () => {
    expect(extensionForMime('video/x-matroska')).toBe('webm');
    expect(extensionForMime('')).toBe('webm');
  });
});
