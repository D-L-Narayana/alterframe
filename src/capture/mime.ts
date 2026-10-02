/** Contract order: prefer MP4/H.264 where the browser can mux it (Safari, recent Chrome), then WebM. */
export const DEFAULT_MIME_CANDIDATES: readonly string[] = [
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/**
 * First candidate accepted by `isTypeSupported`. A throwing predicate (some engines throw on
 * malformed types) counts as "unsupported" so one bad entry never blocks the fallbacks.
 */
export function pickMime(candidates: readonly string[], isTypeSupported: (mime: string) => boolean): string | null {
  for (const mime of candidates) {
    let ok: boolean;
    try {
      ok = isTypeSupported(mime);
    } catch {
      ok = false;
    }
    if (ok) return mime;
  }
  return null;
}
