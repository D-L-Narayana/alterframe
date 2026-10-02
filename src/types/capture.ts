export type CaptureAspect = 'source' | '16:9' | '9:16' | '1:1';

export interface RecorderOptions {
  aspect: CaptureAspect;
  /** Target video bitrate in bps. Default 12_000_000. */
  videoBitsPerSecond?: number;
  /** Preferred mime types in order; first supported wins. */
  mimeCandidates?: string[];
  /** Capture fps for canvas.captureStream. Default 30. */
  fps?: number;
}

export type RecorderState = 'idle' | 'recording' | 'finalizing';

export interface Recorder {
  readonly state: RecorderState;
  readonly elapsedMs: number;
  start(opts: RecorderOptions): Promise<void>;
  stop(): Promise<{ blob: Blob; mime: string; durationMs: number }>;
  /** Save a PNG of the current composited frame. */
  snapshot(aspect: CaptureAspect): Promise<Blob>;
}

export interface PerfSample { t: number; fps: number; frameMs: number; trackingMs: number; renderMs: number }

export interface AdaptiveQualityPolicy {
  /** Given recent samples, return new quality settings or null for no change. */
  evaluate(samples: PerfSample[], current: import('./render').QualitySettings): import('./render').QualitySettings | null;
}
