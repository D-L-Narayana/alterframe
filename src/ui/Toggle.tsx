import { useId, type ReactNode } from 'react';

export interface ToggleProps {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  id?: string;
}

/** Accessible switch: a single <button role="switch"> so label + control are one 44 px target. */
export function Toggle({ label, hint, checked, onChange, disabled, id }: ToggleProps) {
  const autoId = useId();
  const labelId = `${id ?? autoId}-label`;
  const hintId = hint ? `${id ?? autoId}-hint` : undefined;
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className="af-toggle"
      aria-checked={checked}
      aria-labelledby={labelId}
      {...(hintId ? { 'aria-describedby': hintId } : {})}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>
        <span id={labelId} className="af-toggle__label">{label}</span>
        {hint ? <span id={hintId} className="af-toggle__hint">{hint}</span> : null}
      </span>
      <span className="af-toggle__track" aria-hidden="true">
        <span className="af-toggle__thumb" />
      </span>
    </button>
  );
}
