/**
 * Self-timer countdown status ("Recording starts in 3" / "Snapshot in 3") with a Cancel button.
 * The HUD draws the numeral inside the composited frame; this is the accessible, DOM-side mirror.
 */
import { useEffect, useState } from 'react';
import type { CountdownState } from '@/types';
import { useAppStore } from '@/state/store';
import { Button } from '@/ui';

export interface CountdownStatusProps {
  action: 'record' | 'snapshot';
  secondsLeft: number;
  onCancel(): void;
}

export function CountdownStatus({ action, secondsLeft, onCancel }: CountdownStatusProps) {
  const text = action === 'record' ? `Recording starts in ${secondsLeft}` : `Snapshot in ${secondsLeft}`;
  return (
    <div className="af-countdown" role="status">
      <span className="af-countdown__text">{text}</span>
      <Button variant="ghost" onClick={onCancel}>Cancel countdown</Button>
    </div>
  );
}

/** Whole seconds left, 1..ceil(total); a stale clock never shows more than the total. */
export function secondsLeftOf(countdown: CountdownState, now: number): number {
  const total = Math.max(1, Math.ceil(countdown.totalMs / 1000));
  return Math.min(total, Math.max(1, Math.ceil((countdown.endsAt - now) / 1000)));
}

/** Store-connected banner; ticks at 10 Hz while a countdown runs. */
export function CountdownBanner({ onCancel }: { onCancel(): void }) {
  const countdown = useAppStore((s) => s.countdown);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!countdown) return;
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, [countdown]);
  if (!countdown) return null;
  return <CountdownStatus action={countdown.action} secondsLeft={secondsLeftOf(countdown, now)} onCancel={onCancel} />;
}
