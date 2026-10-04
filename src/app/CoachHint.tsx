/** First-use coach hint: shown on the stage until the hand window opens once (or it is dismissed). */
import { useEffect } from 'react';
import { useAppStore } from '@/state/store';
import { useUiStore } from '@/state/uiStore';
import { Button, WindowHandsIcon } from '@/ui';

export const COACH_HINT_TEXT = 'Raise both hands in an L shape — index up, thumb in';

export function CoachHint({ onDismiss }: { onDismiss(): void }) {
  return (
    <div className="af-coach" role="status">
      <WindowHandsIcon />
      <span className="af-coach__text">{COACH_HINT_TEXT}</span>
      <Button variant="ghost" onClick={onDismiss}>Dismiss hint</Button>
    </div>
  );
}

/** Store-connected host: hides the hint for the page session once `session.windowOpen` is true or on dismiss. */
export function CoachHintHost() {
  const windowOpen = useAppStore((s) => s.windowOpen);
  const sourceStatus = useAppStore((s) => s.sourceStatus);
  const done = useUiStore((s) => s.coachHintDone);
  const finish = useUiStore((s) => s.finishCoachHint);
  useEffect(() => {
    if (windowOpen) finish();
  }, [windowOpen, finish]);
  if (done || sourceStatus !== 'ready') return null;
  return <CoachHint onDismiss={finish} />;
}
