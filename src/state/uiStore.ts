/**
 * UI-only state (W1): open panels, toast queue, capture aspect. Memory-only, never persisted.
 * Kept separate from `useAppStore` so the shared `AppState` contract stays untouched.
 */
import { create } from 'zustand';
import type { CaptureAspect } from '@/types';

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
  captureAspect: CaptureAspect;
  /** Facing mode requested for the camera (mobile camera switch). */
  facingMode: 'user' | 'environment';
  openPanel(p: Exclude<Panel, null>): void;
  togglePanel(p: Exclude<Panel, null>): void;
  closePanel(): void;
  notify(message: string, kind?: Toast['kind']): void;
  dismissToast(id?: number): void;
  setCaptureAspect(a: CaptureAspect): void;
  setFacingMode(f: 'user' | 'environment'): void;
}

let toastSeq = 0;

export const useUiStore = create<UiState>()((set, get) => ({
  panel: null,
  toast: null,
  captureAspect: 'source',
  facingMode: 'user',
  openPanel: (p) => set({ panel: p }),
  togglePanel: (p) => set({ panel: get().panel === p ? null : p }),
  closePanel: () => set({ panel: null }),
  notify: (message, kind = 'status') => set({ toast: { id: ++toastSeq, message, kind } }),
  dismissToast: (id) => set((s) => (id === undefined || s.toast?.id === id ? { toast: null } : {})),
  setCaptureAspect: (captureAspect) => set({ captureAspect }),
  setFacingMode: (facingMode) => set({ facingMode }),
}));
