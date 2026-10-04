/** Context-lost / restored toasts driven by `session.contextLost` (written by the runtime). */
import { describe, it, expect, vi } from 'vitest';
import { createAppStore } from '@/state/store';
import { installContextLostToasts } from '@/app/contextLostToasts';

describe('installContextLostToasts', () => {
  it('toasts on lost (assertive) and on restore (polite), once per transition', () => {
    const store = createAppStore();
    const notify = vi.fn();
    const off = installContextLostToasts(store, notify);
    store.getState().setSession({ contextLost: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith('Graphics context lost — recovering', 'error');
    store.getState().setSession({ contextLost: true, fps: 12 }); // unrelated change, same value
    expect(notify).toHaveBeenCalledTimes(1);
    store.getState().setSession({ contextLost: false });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith('Graphics restored', 'status');
    off();
    store.getState().setSession({ contextLost: true });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('does not announce "restored" for the initial false state', () => {
    const store = createAppStore();
    const notify = vi.fn();
    installContextLostToasts(store, notify);
    store.getState().setSession({ fps: 30 });
    expect(notify).not.toHaveBeenCalled();
  });
});
