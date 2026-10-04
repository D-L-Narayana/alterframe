/**
 * UI-only state: open panels, toast, camera facing mode, per-session dismissals. Memory-only, never
 * persisted. Kept separate from `useAppStore` so the shared `AppState` contract stays untouched.
 * (Capture aspect moved to `settings.capture.aspect` in v0.2.)
 */
import { create } from 'zustand';

export type Panel = 'settings' | 'help' | null;

export interface Toast {
  id: number;
  message: string;
  /** 'status' → aria-live polite; 'error' → assertive. */
  kind: 'status' | 'error';
}

export interface UiState {
  panel: Panel;
  toast: Toast | null;
  /** Facing mode requested for the camera (mobile camera switch). */
  facingMode: 'user' | 'environment';
  /** "Continue without tracking" hides the tracker failure card for the current runtime session. */
  trackerFailureDismissed: boolean;
  /** The coach hint was dismissed, or the hand window opened once (page session). */
  coachHintDone: boolean;
  /** Auto-stop length (ms) armed for the recording in progress; null when none. */
  autoStopMs: number | null;
  openPanel(p: Exclude<Panel, null>): void;
  togglePanel(p: Exclude<Panel, null>): void;
  closePanel(): void;
  notify(message: string, kind?: Toast['kind']): void;
  dismissToast(id?: number): void;
  setFacingMode(f: 'user' | 'environment'): void;
  dismissTrackerFailure(): void;
  resetTrackerFailure(): void;
  finishCoachHint(): void;
  setAutoStopMs(ms: number | null): void;
}

let toastSeq = 0;

export const useUiStore = create<UiState>()((set, get) => ({
  panel: null,
  toast: null,
  facingMode: 'user',
  trackerFailureDismissed: false,
  coachHintDone: false,
  autoStopMs: null,
  openPanel: (p) => set({ panel: p }),
  togglePanel: (p) => set({ panel: get().panel === p ? null : p }),
  closePanel: () => set({ panel: null }),
  notify: (message, kind = 'status') => set({ toast: { id: ++toastSeq, message, kind } }),
  dismissToast: (id) => set((s) => (id === undefined || s.toast?.id === id ? { toast: null } : {})),
  setFacingMode: (facingMode) => set({ facingMode }),
  dismissTrackerFailure: () => set({ trackerFailureDismissed: true }),
  resetTrackerFailure: () => set({ trackerFailureDismissed: false }),
  finishCoachHint: () => set({ coachHintDone: true }),
  setAutoStopMs: (autoStopMs) => set({ autoStopMs }),
}));
