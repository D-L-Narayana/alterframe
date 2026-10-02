import type { FrameSource, SourceStatus } from '@/types';

/**
 * W2 extension of the `FrameSource` contract (additive; every W2 source
 * implements it). Lets the runtime / UI react to status changes without
 * polling. Consumers that only know `FrameSource` keep working.
 */
export interface ObservableFrameSource extends FrameSource {
  /** Human-readable error for `denied | unavailable | error`, else null. */
  readonly error: string | null;
  /** Fires on every status transition (also the initial `requesting`). Returns unsubscribe. */
  onStatus(cb: (status: SourceStatus, error: string | null) => void): () => void;
}

export function isObservableSource(s: FrameSource): s is ObservableFrameSource {
  return typeof (s as Partial<ObservableFrameSource>).onStatus === 'function';
}

/** Small status store shared by the sources. */
export function createStatusMachine() {
  let status: SourceStatus = 'idle';
  let error: string | null = null;
  const listeners = new Set<(s: SourceStatus, e: string | null) => void>();
  return {
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    set(next: SourceStatus, nextError: string | null = null): void {
      if (status === next && error === nextError) return;
      status = next;
      error = nextError;
      for (const cb of listeners) cb(status, error);
    },
    onStatus(cb: (s: SourceStatus, e: string | null) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    clear(): void {
      listeners.clear();
    },
  };
}

/**
 * Configures a <video> for silent inline autoplay. Setting the attributes as
 * well as the properties matters on iOS Safari, which inspects attributes.
 */
export function prepareVideoElement(video: HTMLVideoElement): void {
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  if (typeof video.setAttribute === 'function') {
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
  }
}

/** `video.play()` may reject (autoplay policy, AbortError on src change); never let that escape. */
export async function safePlay(video: HTMLVideoElement): Promise<boolean> {
  try {
    const p = video.play();
    if (p && typeof (p as Promise<void>).then === 'function') await p;
    return true;
  } catch {
    return false;
  }
}
