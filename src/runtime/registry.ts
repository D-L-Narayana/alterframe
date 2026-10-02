import type { RuntimeHandle } from '@/types';

/**
 * Production-safe way for UI code (W1 shortcuts, controls) to reach the live
 * runtime WITHOUT a window global: `useRuntime()` keeps the handle in a React
 * ref, and components that cannot see that ref subscribe here.
 * The runtime registers itself in `startRuntime` and clears on `stop()`.
 * One runtime per page; starting a second one replaces the first.
 */
type Listener = (handle: RuntimeHandle | null) => void;

let active: RuntimeHandle | null = null;
const listeners = new Set<Listener>();

export function getActiveRuntime(): RuntimeHandle | null {
  return active;
}

/** Subscribe to runtime start/stop. Fires immediately with the current value. Returns unsubscribe. */
export function subscribeRuntime(cb: Listener): () => void {
  listeners.add(cb);
  cb(active);
  return () => {
    listeners.delete(cb);
  };
}

/** @internal */
export function setActiveRuntime(handle: RuntimeHandle | null): void {
  if (active === handle) return;
  active = handle;
  for (const cb of listeners) cb(active);
}

/** @internal — only clears when `handle` is still the active one (StrictMode double start). */
export function clearActiveRuntime(handle: RuntimeHandle): void {
  if (active === handle) setActiveRuntime(null);
}
