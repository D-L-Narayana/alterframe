import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name; also used as the tooltip. */
  label: string;
  icon: ReactNode;
  /** For toggle buttons: current state (renders aria-pressed). */
  pressed?: boolean;
  /** Optional shortcut hint appended to the tooltip, e.g. "R". */
  shortcut?: string;
  recording?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, pressed, shortcut, recording, className, type = 'button', ...rest },
  ref,
) {
  const cls = ['af-iconbtn', recording && 'af-iconbtn--recording', className].filter(Boolean).join(' ');
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      aria-label={label}
      title={title}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      {...rest}
    >
      {icon}
    </button>
  );
});
