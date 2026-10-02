import { useEffect } from 'react';
import { useUiStore } from '@/state/uiStore';

const AUTO_DISMISS_MS = 3500;

/** Always-mounted live regions (so screen readers pick up changes); the toast is purely visual on top. */
export function StatusToast() {
  const toast = useUiStore((s) => s.toast);
  const dismiss = useUiStore((s) => s.dismissToast);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [toast, dismiss]);

  return (
    <>
      <div className="af-visually-hidden" aria-live="polite" aria-atomic="true">{toast?.kind === 'status' ? toast.message : ''}</div>
      <div className="af-visually-hidden" aria-live="assertive" aria-atomic="true">{toast?.kind === 'error' ? toast.message : ''}</div>
      <div className="af-toast-region" aria-hidden="true">
        {toast ? (
          <div key={toast.id} className={['af-toast', toast.kind === 'error' && 'af-toast--error'].filter(Boolean).join(' ')} onClick={() => dismiss(toast.id)}>
            {toast.message}
          </div>
        ) : null}
      </div>
    </>
  );
}
