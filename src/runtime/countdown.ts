import type { CountdownState, HudCountdown } from '@/types';

/**
 * Self-timer state (store) → what the HUD draws this frame. `now` is in the same clock domain as
 * `countdown.endsAt` (performance.now()). Null when there is no countdown or it has expired;
 * `secondsLeft` never shows 0 (the capture starts at that moment); progress is clamped to 0..1.
 */
export function hudCountdown(countdown: CountdownState | null, now: number): HudCountdown | null {
  if (!countdown || !(countdown.endsAt > now)) return null;
  const remaining = countdown.endsAt - now;
  const raw = countdown.totalMs > 0 ? 1 - remaining / countdown.totalMs : 1;
  return {
    action: countdown.action,
    secondsLeft: Math.max(1, Math.ceil(remaining / 1000)),
    progress: raw < 0 ? 0 : raw > 1 ? 1 : raw,
  };
}
