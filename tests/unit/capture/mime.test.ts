import { describe, it, expect } from 'vitest';
import { DEFAULT_MIME_CANDIDATES, pickMime } from '@/capture/mime';

describe('DEFAULT_MIME_CANDIDATES', () => {
  it('lists the contract order mp4/avc1 → vp9 → vp8 → webm', () => {
    expect(DEFAULT_MIME_CANDIDATES).toEqual([
      'video/mp4;codecs=avc1',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ]);
  });
});

describe('pickMime', () => {
  it('returns the first candidate the recorder supports', () => {
    const supported = new Set(['video/webm;codecs=vp8', 'video/webm']);
    expect(pickMime(DEFAULT_MIME_CANDIDATES, (m) => supported.has(m))).toBe('video/webm;codecs=vp8');
  });
  it('prefers mp4 when supported', () => {
    expect(pickMime(DEFAULT_MIME_CANDIDATES, () => true)).toBe('video/mp4;codecs=avc1');
  });
  it('returns null when nothing is supported', () => {
    expect(pickMime(DEFAULT_MIME_CANDIDATES, () => false)).toBeNull();
  });
  it('tolerates isTypeSupported throwing (treats as unsupported)', () => {
    const pick = pickMime(['video/mp4;codecs=avc1', 'video/webm'], (m) => {
      if (m.startsWith('video/mp4')) throw new TypeError('boom');
      return true;
    });
    expect(pick).toBe('video/webm');
  });
  it('honours a custom candidate list', () => {
    expect(pickMime(['video/webm;codecs=vp9'], () => true)).toBe('video/webm;codecs=vp9');
  });
});
