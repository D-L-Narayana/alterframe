import { forwardRef } from 'react';
import { useAppStore } from '@/state/store';

export interface StageProps {
  /** Shown while the tracking models load. */
  loading: boolean;
}

/** Full-viewport composited canvas (W4 draws into it via the W2 runtime). */
export const Stage = forwardRef<HTMLCanvasElement, StageProps>(function Stage({ loading }, ref) {
  const sourceKind = useAppStore((s) => s.sourceKind);
  return (
    <div className="af-stage">
      <canvas
        id="stage"
        ref={ref}
        className="af-stage__canvas"
        role="img"
        aria-label={
          sourceKind === 'camera'
            ? 'Live stage: your mirrored camera with the hand-window alter-ego effect'
            : 'Stage: the opened video with the hand-window alter-ego effect'
        }
      />
      {loading ? (
        <div className="af-stage__loader" aria-hidden="true">
          <div className="af-stage__loader-bar" />
          <span className="af-stage__loader-text">Loading tracking models…</span>
        </div>
      ) : null}
    </div>
  );
});
