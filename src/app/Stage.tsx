import { forwardRef } from 'react';
import { useAppStore } from '@/state/store';

export interface StageProps {
  /** Shown while the tracking models load (hidden once the tracker is ready or has failed). */
  loading: boolean;
}

/** Determinate model-download bar. `progress` is 0..1 (`session.trackerProgress`). */
export function TrackerProgress({ progress }: { progress: number }) {
  const pct = Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0;
  return (
    <div
      className="af-stage__loader"
      role="progressbar"
      aria-label="Loading tracking models"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className={['af-stage__loader-track', pct === 0 && 'af-stage__loader-track--waiting'].filter(Boolean).join(' ')}>
        <div className="af-stage__loader-bar" style={{ width: `${pct}%` }} />
      </div>
      <span className="af-stage__loader-text">Loading tracking models… {pct}%</span>
    </div>
  );
}

/** Full-viewport composited canvas (the renderer draws into it via the runtime). */
export const Stage = forwardRef<HTMLCanvasElement, StageProps>(function Stage({ loading }, ref) {
  const sourceKind = useAppStore((s) => s.sourceKind);
  const progress = useAppStore((s) => s.trackerProgress);
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
      {loading ? <TrackerProgress progress={progress} /> : null}
    </div>
  );
});
