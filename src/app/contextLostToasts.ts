/** Toasts for `session.contextLost` transitions (the runtime mirrors webglcontextlost / restored). */
import type { AppStore } from '@/types';

export const CONTEXT_LOST_MESSAGE = 'Graphics context lost — recovering';
export const CONTEXT_RESTORED_MESSAGE = 'Graphics restored';

/** Subscribes to the store; returns the unsubscribe. Announces each transition exactly once. */
export function installContextLostToasts(store: AppStore, notify: (message: string, kind: 'status' | 'error') => void): () => void {
  let previous = store.getState().contextLost;
  return store.subscribe((s) => {
    if (s.contextLost === previous) return;
    previous = s.contextLost;
    if (s.contextLost) notify(CONTEXT_LOST_MESSAGE, 'error');
    else notify(CONTEXT_RESTORED_MESSAGE, 'status');
  });
}
