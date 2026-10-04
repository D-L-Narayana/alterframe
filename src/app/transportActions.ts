/**
 * File-transport keyboard actions (P / [ / ] / L). Pure: the transport is read on demand so the same
 * actions object serves camera sessions (no transport → every action is a silent no-op).
 */
import type { FileTransport } from '@/types';

export interface TransportActionDeps {
  getTransport(): FileTransport | null;
  notify(message: string, kind?: 'status' | 'error'): void;
}

export interface TransportActions {
  togglePlayback(): void;
  seekBy(deltaSeconds: number): void;
  toggleLoop(): void;
}

export function createTransportActions(deps: TransportActionDeps): TransportActions {
  return {
    togglePlayback() {
      const t = deps.getTransport();
      if (!t) return;
      if (!t.paused) {
        t.pause();
        return;
      }
      t.play().then(
        (ok) => {
          if (!ok) deps.notify('Playback was blocked by the browser — use the Play button.', 'error');
        },
        () => deps.notify('Playback could not start.', 'error'),
      );
    },
    seekBy(deltaSeconds) {
      const t = deps.getTransport();
      if (!t) return;
      const max = Number.isFinite(t.duration) ? t.duration : Number.POSITIVE_INFINITY;
      t.seek(Math.min(max, Math.max(0, t.currentTime + deltaSeconds)));
    },
    toggleLoop() {
      const t = deps.getTransport();
      if (!t) return;
      const next = !t.loop;
      t.setLoop(next);
      deps.notify(next ? 'Loop on' : 'Loop off');
    },
  };
}
