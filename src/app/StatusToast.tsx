import { useEffect } from 'react';
import { useUiStore, type Toast } from '@/state/uiStore';

const AUTO_DISMISS_MS = 3500;

/**
 * Always-mounted live regions: `role="status"` (polite) for ordinary notices, `role="alert"`
 * (assertive) for failures. Both roles imply the matching aria-live and make the texts locatable by role.
 */
export function ToastLiveRegions({ toast }: { toast: Toast | null }) {
  return (
    <>
      <div className="af-visually-hidden" role="status" aria-live="polite" aria-atomic="true">{toast?.kind === 'status' ? toast.message : ''}</div>
      <div className="af-visually-hidden" role="alert" aria-live="assertive" aria-atomic="true">{toast?.kind === 'error' ? toast.message : ''}</div>
    </>
  );
}

/** Live regions (announcement) + a purely visual, auto-dismissing toast on top. */
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
      <ToastLiveRegions toast={toast} />
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
