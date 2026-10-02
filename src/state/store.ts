/**
 * Application store (W1). Implements `AppState` from src/types/store.ts exactly.
 *
 * - Settings are persisted through a pluggable `SettingsStorage` (memory-only by default,
 *   see persistence.ts; key `alterframe.settings.v1`, versioned envelope).
 * - `setScene` recomputes `hudTint` when `hudTintAuto` (comic → red, live → white), the
 *   behaviour observed in the reference (reference-analysis.md §2.2).
 * - `cyclePersona` follows `PERSONA_ORDER`.
 */
import { create } from 'zustand';
import {
  DEFAULT_SCENE,
  PERSONA_ORDER,
  type AppState,
  type AppStore,
  type BaseStyle,
  type HudTint,
  type SceneSlice,
  type SceneState,
  type SessionSlice,
  type SettingsSlice,
} from '@/types';
import {
  createMemoryStorage,
  defaultSettings,
  deserializeSettings,
  serializeSettings,
  SETTINGS_STORAGE_KEY,
  type SettingsData,
  type SettingsStorage,
} from './persistence';

export interface CreateAppStoreOptions {
  storage?: SettingsStorage;
}

/** HUD tint rule from the reference: red on the comic base, white on live. */
export function autoHudTint(base: BaseStyle): HudTint {
  return base === 'comic' ? 'red' : 'white';
}

export function nextPersona(scene: SceneState): SceneState['persona'] {
  const i = PERSONA_ORDER.indexOf(scene.persona);
  return PERSONA_ORDER[(i + 1) % PERSONA_ORDER.length] ?? PERSONA_ORDER[0]!;
}

const SETTINGS_KEYS: ReadonlyArray<keyof SettingsData> = [
  'mirrored', 'hudEnabled', 'hudTintAuto', 'showFps', 'debugLandmarks',
  'interaction', 'quality', 'adaptiveQuality', 'reducedMotion',
];

function pickSettings(state: AppState): SettingsData {
  const out: Partial<SettingsData> = {};
  for (const k of SETTINGS_KEYS) {
    // Index assignment through a generic key keeps this strictly typed without `any`.
    (out as Record<string, unknown>)[k] = state[k];
  }
  return out as SettingsData;
}

export function createAppStore(opts: CreateAppStoreOptions = {}): AppStore {
  const storage = opts.storage ?? createMemoryStorage();
  const restored = deserializeSettings(storage.get(SETTINGS_STORAGE_KEY));
  const initialSettings: SettingsData = { ...defaultSettings(), ...(restored ?? {}) };

  const store = create<AppState>()((set, get) => {
    const persist = () => {
      try {
        storage.set(SETTINGS_STORAGE_KEY, serializeSettings(pickSettings(get())));
      } catch {
        // Storage failures must never break the UI (quota, privacy mode…).
      }
    };

    const settings: SettingsSlice = {
      ...initialSettings,
      setSettings(partial) {
        set((s) => {
          const nextAuto = partial.hudTintAuto ?? s.hudTintAuto;
          const scene = nextAuto && !s.hudTintAuto
            ? { ...s.scene, hudTint: autoHudTint(s.scene.base) }
            : s.scene;
          return { ...partial, scene };
        });
        persist();
      },
    };

    const sceneSlice: SceneSlice = {
      scene: { ...DEFAULT_SCENE, hudTint: initialSettings.hudTintAuto ? autoHudTint(DEFAULT_SCENE.base) : DEFAULT_SCENE.hudTint },
      directorRunning: false,
      setScene(partial) {
        set((s) => {
          const merged: SceneState = { ...s.scene, ...partial };
          if (s.hudTintAuto) merged.hudTint = autoHudTint(merged.base);
          return { scene: merged };
        });
      },
      cyclePersona() {
        get().setScene({ persona: nextPersona(get().scene) });
      },
      setDirectorRunning(v) {
        set({ directorRunning: v });
      },
    };

    const session: SessionSlice = {
      sourceKind: 'camera',
      sourceStatus: 'idle',
      sourceError: null,
      cameraDeviceId: null,
      trackerReady: false,
      fps: 0,
      recorderState: 'idle',
      recorderElapsedMs: 0,
      setSession(partial) {
        set(partial);
      },
    };

    return { ...settings, ...sceneSlice, ...session };
  });

  return store;
}

/** The single app store. Memory-only persistence (project override; see docs/handoffs/W1.md). */
export const useAppStore: AppStore = createAppStore();

export const selectScene = (s: AppState): SceneState => s.scene;
export const selectSettings = (s: AppState): SettingsData => ({
  mirrored: s.mirrored,
  hudEnabled: s.hudEnabled,
  hudTintAuto: s.hudTintAuto,
  showFps: s.showFps,
  debugLandmarks: s.debugLandmarks,
  interaction: s.interaction,
  quality: s.quality,
  adaptiveQuality: s.adaptiveQuality,
  reducedMotion: s.reducedMotion,
});
export const selectSession = (s: AppState): Omit<SessionSlice, 'setSession'> => ({
  sourceKind: s.sourceKind,
  sourceStatus: s.sourceStatus,
  sourceError: s.sourceError,
  cameraDeviceId: s.cameraDeviceId,
  trackerReady: s.trackerReady,
  fps: s.fps,
  recorderState: s.recorderState,
  recorderElapsedMs: s.recorderElapsedMs,
});
