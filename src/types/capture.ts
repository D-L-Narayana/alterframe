export type CaptureAspect = 'source' | '16:9' | '9:16' | '1:1';

/** Self-timer before a recording/snapshot starts (seconds; 0 = immediate). */
export type SelfTimerSeconds = 0 | 3 | 5 | 10;
/** Automatic recording stop (seconds; 0 = manual stop only). */
export type AutoStopSeconds = 0 | 10 | 15 | 30 | 60;
export type SnapshotFormat = 'png' | 'jpeg' | 'webp';
/** What the hold-still gesture triggers. */
export type DwellAction = 'off' | 'snapshot' | 'record';

export interface CaptureSettings {
  aspect: CaptureAspect;
  selfTimer: SelfTimerSeconds;
  autoStop: AutoStopSeconds;
  snapshotFormat: SnapshotFormat;
  dwellAction: DwellAction;
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = { aspect: 'source', selfTimer: 0, autoStop: 0, snapshotFormat: 'png', dwellAction: 'off' };

export interface SnapshotOptions {
  /** Default 'png'. Browsers that cannot encode the requested type fall back to PNG. */
  format?: SnapshotFormat;
  /** 0..1 encoder quality for lossy formats (default 0.92). */
  quality?: number;
}

export interface RecorderOptions {
  aspect: CaptureAspect;
  /** Target video bitrate in bps. Default 12_000_000. */
  videoBitsPerSecond?: number;
  /** Preferred mime types in order; first supported wins. */
  mimeCandidates?: string[];
  /** Capture fps for canvas.captureStream. Default 30. */
  fps?: number;
  /**
   * Hard cap on the recording length (ms). When reached the recorder finalizes on its own; the result
   * is held as a pending result and returned by the next `stop()`. Default 600_000.
   */
  maxDurationMs?: number;
}

export type RecorderState = 'idle' | 'recording' | 'finalizing';

export interface Recorder {
  readonly state: RecorderState;
  readonly elapsedMs: number;
  start(opts: RecorderOptions): Promise<void>;
  /** Stops and returns the recording. If the recorder already finalized on its own (maxDurationMs), resolves once with that pending result. */
  stop(): Promise<{ blob: Blob; mime: string; durationMs: number }>;
  /** Save an image of the current composited frame (PNG by default). */
  snapshot(aspect: CaptureAspect, opts?: SnapshotOptions): Promise<Blob>;
  /** True when a self-finalized recording is waiting to be collected by `stop()`. */
  readonly hasPendingResult?: boolean;
}

export interface PerfSample { t: number; fps: number; frameMs: number; trackingMs: number; renderMs: number }

export interface AdaptiveQualityPolicy {
  /** Given recent samples, return new quality settings or null for no change. */
  evaluate(samples: PerfSample[], current: import('./render').QualitySettings): import('./render').QualitySettings | null;
}
