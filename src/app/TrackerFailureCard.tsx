import { Button, RetryIcon } from '@/ui';

export interface TrackerFailureCardProps {
  /** Human-readable tracker init failure (`session.trackerError`). */
  message: string;
  /** "Retry tracking" → `handle.retryTracker?.()`. */
  onRetry(): void;
  /** "Continue without tracking" → hides the card; the stage keeps running untracked. */
  onContinue(): void;
}

const FALLBACK = 'Check your connection and try again. You can keep using the live video without the hand window.';

/**
 * Non-blocking failure card shown over the stage when the tracking models could not be loaded.
 * `role="alert"` announces it; the stage and controls stay usable behind it.
 */
export function TrackerFailureCard({ message, onRetry, onContinue }: TrackerFailureCardProps) {
  return (
    <div className="af-tracker-card" role="alert" aria-labelledby="af-tracker-card-title">
      <h2 id="af-tracker-card-title">Tracking models could not be loaded</h2>
      <p>{message || FALLBACK}</p>
      <div className="af-tracker-card__actions">
        <Button variant="primary" icon={<RetryIcon />} onClick={onRetry}>Retry tracking</Button>
        <Button variant="ghost" onClick={onContinue}>Continue without tracking</Button>
      </div>
    </div>
  );
}
