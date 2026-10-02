import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Shortcut hint rendered next to the label (e.g. "1"). */
  shortcut?: string;
  accent?: boolean;
  ariaLabel?: string;
}

export interface SegmentedProps<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(v: T): void;
  block?: boolean;
  className?: string;
}

/**
 * Radiogroup with roving tabindex: Tab enters once, Arrow keys move selection, Home/End jump.
 * Used for persona (1/2/3) and base (live/comic).
 */
export function Segmented<T extends string>({ label, options, value, onChange, block, className }: SegmentedProps<T>) {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next === null) return;
    e.preventDefault();
    const opt = options[next];
    if (!opt) return;
    onChange(opt.value);
    refs.current[next]?.focus();
  };

  const cls = ['af-seg', block && 'af-seg--block', className].filter(Boolean).join(' ');
  return (
    <div role="radiogroup" aria-label={label} className={cls} id={id}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={selected}
            {...(o.ariaLabel ? { 'aria-label': o.ariaLabel } : {})}
            tabIndex={selected ? 0 : -1}
            className={['af-seg__opt', o.accent && 'af-seg__opt--accent'].filter(Boolean).join(' ')}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
          >
            {o.label}
            {o.shortcut ? <span className="af-seg__key" aria-hidden="true">{o.shortcut}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
