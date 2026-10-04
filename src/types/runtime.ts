import type { FrameSource, RuntimeStats, SourceKind, SourceStatus } from './media';
import type { Recorder, CaptureAspect, SnapshotOptions } from './capture';
import type { TrackingFrame, Tracker, TrackerInfo, TrackerOptions } from './tracking';
import type { QualitySettings } from './render';
import type { Size } from './geometry';
import type { AppState } from './store';
import type { StoreApi, UseBoundStore } from 'zustand';

/** Store handle type as exported by the state module (`useAppStore`). */
export type AppStore = UseBoundStore<StoreApi<AppState>>;

export interface RuntimeDeps {
  canvas: HTMLCanvasElement;
  store: AppStore;
  source: FrameSource;
}

/** One snapshot of everything useful in a bug report. Plain data; safe to JSON.stringify. */
export interface RuntimeDiagnostics {
  fps: number;
  frameMs: number;
  trackingMs: number;
  renderMs: number;
  gpuMs: number | null;
  frames: number;
  tracker: {
    ready: boolean;
    progress: number;
    error: string | null;
    delegates: TrackerInfo['delegates'] | null;
    inferenceSize: Size | null;
    warnings: string[];
  };
  renderer: { contextLost: boolean; contextLossCount: number; internal: Size | null; maskFormat: string | null } | null;
  quality: QualitySettings;
  source: { kind: SourceKind; status: SourceStatus; width: number; height: number };
  modules: { stubbed: readonly string[] };
}

export interface RuntimeHandle {
  stop(): void;
  recorder: Recorder;
  snapshot(aspect: CaptureAspect, opts?: SnapshotOptions): Promise<Blob>;
  getStats(): RuntimeStats;
  setSource(source: FrameSource): Promise<void>;
  /** Re-run tracker initialisation after a failure. Resolves when settled (success or failure); never rejects. */
  retryTracker?(): Promise<void>;
  /** Render one frame now even if the source presents no new frame (paused file, settings change). */
  requestRender?(): void;
  getDiagnostics?(): RuntimeDiagnostics;
  /**
   * Test hook (e2e): when called with a frame, the runtime uses it instead of the real tracker
   * until called with null. Present only in dev / VITE_E2E builds.
   */
  injectTracking?(frame: TrackingFrame | null): void;
}

/** Exact factory signature the runtime imports. */
export type CreateTracker = (opts?: TrackerOptions, onProgress?: (progress01: number) => void) => Tracker;

/** Overlay canvases (persona, HUD) may set this to skip redundant GPU uploads (the compositor honours it). */
export type DirtyCanvas = (HTMLCanvasElement | OffscreenCanvas) & { __dirty?: boolean };

declare global {
  interface Window { __alterframe?: RuntimeHandle }
}
