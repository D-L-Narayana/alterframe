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
  /** Called on Esc instead of `onClose` (lets the app apply its Esc priority, e.g. cancel a countdown first). */
  onEscape?: () => void;
}

/** Modal dialog: role=dialog, aria-modal, focus trap, Esc closes, focus restored on close. */
export function Dialog({ open, title, onClose, children, footer, variant = 'dialog', describedBy, onEscape }: DialogProps) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(ref, open, onEscape ?? onClose, closeRef);
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
        {/* The body scrolls when the content is taller than the panel: keyboard users must be able to focus it to scroll (axe scrollable-region-focusable). */}
        <div className="af-panel__body" tabIndex={0}>{children}</div>
        {footer ? <div className="af-panel__foot">{footer}</div> : null}
      </div>
    </>
  );
}
