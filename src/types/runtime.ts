import type { FrameSource, RuntimeStats } from './media';
import type { Recorder, CaptureAspect } from './capture';
import type { TrackingFrame, Tracker, TrackerOptions } from './tracking';
import type { AppState } from './store';
import type { StoreApi, UseBoundStore } from 'zustand';

/** Store handle type as exported by W1 (`useAppStore`). */
export type AppStore = UseBoundStore<StoreApi<AppState>>;

export interface RuntimeDeps {
  canvas: HTMLCanvasElement;
  store: AppStore;
  source: FrameSource;
}

export interface RuntimeHandle {
  stop(): void;
  recorder: Recorder;
  snapshot(aspect: CaptureAspect): Promise<Blob>;
  getStats(): RuntimeStats;
  setSource(source: FrameSource): Promise<void>;
  /**
   * Test hook (W10 e2e): when called with a frame, the runtime uses it instead of the real tracker
   * until called with null. Enabled only in dev or when the page URL has `?mockTracking=1`.
   */
  injectTracking?(frame: TrackingFrame | null): void;
}

/** Exact factory signatures the runtime (W2) imports. */
export type CreateTracker = (opts?: TrackerOptions, onProgress?: (progress01: number) => void) => Tracker;

/** Overlay canvases (W6 persona, W8 HUD) may set this to skip redundant GPU uploads (W4 honours it). */
export type DirtyCanvas = (HTMLCanvasElement | OffscreenCanvas) & { __dirty?: boolean };

declare global {
  interface Window { __alterframe?: RuntimeHandle }
}
