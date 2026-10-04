/** Small pure helpers for the UI. */
import type { SourceStatus } from '@/types';

/** mm:ss, minutes not wrapped (a 60-minute recording shows 60:00). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Seconds (e.g. a media `currentTime`) → mm:ss; NaN/∞ read as 00:00. */
export function formatSeconds(seconds: number): string {
  return formatElapsed(Number.isFinite(seconds) ? seconds * 1000 : 0);
}

const pad = (n: number) => String(n).padStart(2, '0');

export type CaptureExtension = 'png' | 'jpg' | 'webp' | 'webm' | 'mp4';

/**
 * Container/encoder type → file extension; codec parameters are ignored. Images default to png,
 * unknown video to webm (what MediaRecorder produces when it is not mp4).
 */
export function extensionForMime(mime: string): CaptureExtension {
  const m = mime.toLowerCase();
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('png') || m.startsWith('image/')) return 'png';
  return 'webm';
}

/** `alterframe-YYYYMMDD-HHMMSS.{png|jpg|webp|webm|mp4}` — same convention as the capture module. */
export function captureFilename(mimeOrExt: string, now: Date = new Date()): string {
  const ext = mimeOrExt.includes('/') ? extensionForMime(mimeOrExt) : mimeOrExt || 'png';
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `alterframe-${stamp}.${ext}`;
}

/** Maps a getUserMedia / source failure to a session status + human message. */
export function mapSourceError(err: unknown): { status: Extract<SourceStatus, 'denied' | 'unavailable' | 'error'>; message: string } {
  // The media module's MediaSourceError already carries a classified status + readable message.
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (status === 'denied' || status === 'unavailable' || status === 'error') {
      const message = err instanceof Error && err.message ? err.message : '';
      if (message) return { status, message };
    }
  }
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { status: 'denied', message: 'Camera access was denied. Allow the camera in your browser settings, or open a video file instead.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { status: 'unavailable', message: 'No usable camera was found. Connect one, or open a video file instead.' };
    default:
      return { status: 'error', message: detail ? `The camera could not be started: ${detail}` : 'The camera could not be started.' };
  }
}

/** Triggers a browser download for a Blob (object URL revoked afterwards). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Delay revoke so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
