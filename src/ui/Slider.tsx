import { useId, type ReactNode } from 'react';

export interface SliderProps {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(v: number): void;
  /** Formats the displayed value (default: raw number). */
  format?: (v: number) => string;
  disabled?: boolean;
  hint?: ReactNode;
}

export function Slider({ label, value, min, max, step, onChange, format, disabled, hint }: SliderProps) {
  const id = useId();
  const text = format ? format(value) : String(value);
  return (
    <div className="af-slider">
      <div className="af-slider__head">
        <label htmlFor={id} className="af-slider__label">{label}</label>
        <output htmlFor={id} className="af-slider__value" aria-live="off">{text}</output>
      </div>
      <input
        id={id}
        className="af-slider__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={text}
        {...(hint ? { 'aria-describedby': `${id}-hint` } : {})}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      {hint ? <span id={`${id}-hint`} className="af-field__hint">{hint}</span> : null}
    </div>
  );
}
