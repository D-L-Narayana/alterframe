import type { SourceStatus } from '@/types';

/** Terminal statuses a `FrameSource.start()` rejection can carry. */
export type SourceFailureStatus = Extract<SourceStatus, 'denied' | 'unavailable' | 'error'>;

/**
 * Thrown (as a rejected promise) by `FrameSource.start()` when the source
 * cannot become `ready`. `status` matches the source's `status` property so
 * callers may either `catch` or inspect the source — both work.
 */
export class MediaSourceError extends Error {
  readonly status: SourceFailureStatus;
  /** Original DOMException / Error when available. */
  override readonly cause: unknown;
  constructor(status: SourceFailureStatus, message: string, cause?: unknown) {
    super(message);
    this.name = 'MediaSourceError';
    this.status = status;
    this.cause = cause;
  }
}

/**
 * Maps a getUserMedia rejection to a status + human-readable message.
 * Pure; exported for tests. Names follow the WebRTC spec / Chromium / Firefox.
 */
export function classifyGetUserMediaError(err: unknown): { status: SourceFailureStatus; message: string } {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { status: 'denied', message: 'Camera access was denied. Allow camera access in your browser, or open a video file instead.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
    case 'NotSupportedError':
    case 'TypeError': // getUserMedia with no usable constraints / API missing in insecure contexts
      return { status: 'unavailable', message: 'No usable camera was found on this device. You can open a video file instead.' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { status: 'error', message: `The camera is busy or could not be started${detail}. Close other apps using it and retry.` };
    default:
      return { status: 'error', message: `Could not start the camera${detail}.` };
  }
}
