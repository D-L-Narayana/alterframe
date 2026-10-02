export type CaptureExtension = 'webm' | 'mp4' | 'png';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `alterframe-YYYYMMDD-HHMMSS.{webm|mp4|png}` using the local clock (what the user sees). */
export function captureFilename(ext: CaptureExtension, date: Date = new Date()): string {
  const y = date.getFullYear();
  const stamp =
    `${y}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `alterframe-${stamp}.${ext}`;
}

/** Container → extension; codec parameters (`;codecs=...`) are ignored. Unknown video → webm. */
export function extensionForMime(mime: string): CaptureExtension {
  const container = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (container === 'video/mp4') return 'mp4';
  if (container === 'image/png') return 'png';
  return 'webm';
}
