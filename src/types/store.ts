import type { SceneState } from './scene';
import type { InteractionSettings } from './interaction';
import type { QualitySettings } from './render';
import type { SourceStatus, SourceKind } from './media';
import type { RecorderState } from './capture';

/** Shape of the zustand store owned by W1 (src/state/store.ts). Other workers import `useAppStore` and these types only. */
export interface SettingsSlice {
  mirrored: boolean;
  hudEnabled: boolean;
  hudTintAuto: boolean;         // red on comic base, white on live (observed)
  showFps: boolean;
  debugLandmarks: boolean;
  interaction: InteractionSettings;
  quality: QualitySettings;
  adaptiveQuality: boolean;
  reducedMotion: boolean;       // honours prefers-reduced-motion; disables glitch/flicker
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
  fps: number;
  recorderState: RecorderState;
  recorderElapsedMs: number;
  setSession(partial: Partial<Omit<SessionSlice, 'setSession'>>): void;
}

export type AppState = SettingsSlice & SceneSlice & SessionSlice;
