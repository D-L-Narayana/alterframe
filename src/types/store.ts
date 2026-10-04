import type { SceneState } from './scene';
import type { InteractionSettings } from './interaction';
import type { FitMode, LookSettings, QualitySettings } from './render';
import type { SourceStatus, SourceKind, TransportState } from './media';
import type { CaptureSettings, RecorderState } from './capture';

/** A running self-timer. `endsAt` is in the performance.now() domain. */
export interface CountdownState { action: 'record' | 'snapshot'; endsAt: number; totalMs: number }

/** A capture triggered by the runtime (hold-still gesture); the app performs it and clears the field. */
export interface CaptureRequest { action: 'snapshot' | 'record'; id: number; source: 'dwell' }

/** Shape of the zustand store (src/state/store.ts). Other modules import `useAppStore` and these types only. */
export interface SettingsSlice {
  mirrored: boolean;
  hudEnabled: boolean;
  hudTintAuto: boolean;         // red on comic base, white on live
  showFps: boolean;
  debugLandmarks: boolean;
  interaction: InteractionSettings;
  quality: QualitySettings;
  adaptiveQuality: boolean;
  reducedMotion: boolean;       // honours prefers-reduced-motion; disables glitch/flicker/parallax
  fitMode: FitMode;
  /** Optional thin-slit glitch inside a very thin window (off by default; never under reduced motion). */
  thinStripGlitch: boolean;
  look: LookSettings;
  capture: CaptureSettings;
  setSettings(partial: Partial<Omit<SettingsSlice, 'setSettings'>>): void;
}

export interface SceneSlice {
  scene: SceneState;
  directorRunning: boolean;
  setScene(partial: Partial<SceneState>): void;
  cyclePersona(): void;
  setDirectorRunning(v: boolean): void;
}

export interface SessionSlice {
  sourceKind: SourceKind;
  sourceStatus: SourceStatus;
  sourceError: string | null;
  cameraDeviceId: string | null;
  trackerReady: boolean;
  /** 0..1 model download / init progress (1 once ready). */
  trackerProgress: number;
  /** Human-readable tracker init failure, or null. */
  trackerError: string | null;
  /** True while the hand window is visible. */
  windowOpen: boolean;
  /** True between webglcontextlost and webglcontextrestored. */
  contextLost: boolean;
  fps: number;
  recorderState: RecorderState;
  recorderElapsedMs: number;
  countdown: CountdownState | null;
  /** Mirrored FileTransport state; null for camera sources. */
  transport: TransportState | null;
  captureRequest: CaptureRequest | null;
  setSession(partial: Partial<Omit<SessionSlice, 'setSession'>>): void;
}

export type AppState = SettingsSlice & SceneSlice & SessionSlice;
