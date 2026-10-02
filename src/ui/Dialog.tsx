import { useId, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton';
import { CloseIcon } from './icons';
import { useFocusTrap } from './useFocusTrap';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  /** 'dialog' = centred modal; 'sheet' = side (desktop) / bottom (mobile) panel. */
  variant?: 'dialog' | 'sheet';
  describedBy?: string;
}

/** Modal dialog: role=dialog, aria-modal, focus trap, Esc closes, focus restored on close. */
export function Dialog({ open, title, onClose, children, footer, variant = 'dialog', describedBy }: DialogProps) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(ref, open, onClose, closeRef);
  if (!open) return null;
  return (
    <>
      <div className="af-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        className={variant === 'sheet' ? 'af-sheet' : 'af-dialog'}
        tabIndex={-1}
      >
        <div className="af-panel__head">
          <h2 id={`${id}-title`} className="af-panel__title">{title}</h2>
          <IconButton ref={closeRef} label="Close" shortcut="Esc" icon={<CloseIcon />} onClick={onClose} />
        </div>
        <div className="af-panel__body">{children}</div>
        {footer ? <div className="af-panel__foot">{footer}</div> : null}
      </div>
    </>
  );
}
