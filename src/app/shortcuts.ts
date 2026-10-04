/**
 * Global keyboard shortcuts. Pure resolution logic is separated from the DOM listener so it can be
 * unit-tested in Node. Recording/snapshot/transport actions are wired by the App to the real
 * `RuntimeHandle` / `FrameSource` (held in React refs) — never through the dev-only window global.
 */
import type { PersonaId } from '@/types';

export type ShortcutAction =
  | { type: 'persona'; persona: PersonaId }
  | { type: 'toggle-base' }
  | { type: 'toggle-hud' }
  | { type: 'toggle-record' }
  | { type: 'timed-record' }
  | { type: 'snapshot' }
  | { type: 'toggle-director' }
  | { type: 'toggle-mirror' }
  | { type: 'toggle-fps' }
  | { type: 'toggle-playback' }
  | { type: 'seek'; deltaSeconds: number }
  | { type: 'toggle-loop' }
  | { type: 'toggle-help' }
  | { type: 'escape' };

export interface ShortcutKeyInfo {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Upper-case tagName of the event target. */
  targetTag: string;
  isContentEditable: boolean;
}

export interface ShortcutActions {
  setPersona(p: PersonaId): void;
  toggleBase(): void;
  toggleHud(): void;
  toggleRecord(): void;
  /** `T`: recording after the self-timer (3 s when the timer is off); again cancels. */
  timedRecord(): void;
  snapshot(): void;
  toggleDirector(): void;
  toggleMirror(): void;
  toggleFps(): void;
  /** File sources only (no-ops without a transport). */
  togglePlayback(): void;
  seekBy(deltaSeconds: number): void;
  toggleLoop(): void;
  toggleHelp(): void;
  escape(): void;
}

export interface ShortcutDoc { keys: string[]; label: string }

/** Shown in the Help dialog; keep in sync with `resolveShortcut`. */
export const SHORTCUT_MAP: readonly ShortcutDoc[] = [
  { keys: ['1', '2', '3'], label: 'Persona: Portrait / Masked hero / Web suit' },
  { keys: ['B'], label: 'Toggle base style (live / comic)' },
  { keys: ['H'], label: 'Toggle HUD callouts' },
  { keys: ['R'], label: 'Start / stop recording (after the Self-timer when one is set)' },
  { keys: ['T'], label: 'Timed recording: Self-timer value, 3 s when it is off — press again to cancel' },
  { keys: ['S'], label: 'Save a snapshot (PNG / JPEG / WebP, see Settings → Capture)' },
  { keys: ['D'], label: 'Director: play / stop the reel sequence' },
  { keys: ['M'], label: 'Toggle mirror' },
  { keys: ['F'], label: 'Toggle fps badge' },
  { keys: ['P'], label: 'Play / pause the video file' },
  { keys: ['[', ']'], label: 'Seek the video file −1 s / +1 s' },
  { keys: ['L'], label: 'Toggle loop for the video file' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Cancel countdown → close panels → stop recording' },
];

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function resolveShortcut(e: ShortcutKeyInfo): ShortcutAction | null {
  if (e.key === 'Escape') return { type: 'escape' };
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (TYPING_TAGS.has(e.targetTag) || e.isContentEditable) return null;
  switch (e.key) {
    case '1': return { type: 'persona', persona: 'portrait' };
    case '2': return { type: 'persona', persona: 'masked' };
    case '3': return { type: 'persona', persona: 'suit' };
    case 'b': case 'B': return { type: 'toggle-base' };
    case 'h': case 'H': return { type: 'toggle-hud' };
    case 'r': case 'R': return { type: 'toggle-record' };
    case 't': case 'T': return { type: 'timed-record' };
    case 's': case 'S': return { type: 'snapshot' };
    case 'd': case 'D': return { type: 'toggle-director' };
    case 'm': case 'M': return { type: 'toggle-mirror' };
    case 'f': case 'F': return { type: 'toggle-fps' };
    case 'p': case 'P': return { type: 'toggle-playback' };
    case '[': return { type: 'seek', deltaSeconds: -1 };
    case ']': return { type: 'seek', deltaSeconds: 1 };
    case 'l': case 'L': return { type: 'toggle-loop' };
    case '?': return { type: 'toggle-help' };
    default: return null;
  }
}

export type EscapeTarget = 'cancel-countdown' | 'close-panel' | 'stop-recording' | null;

/** Esc priority: a running self-timer is cancelled first, then an open panel closes, then a recording stops. */
export function resolveEscape(state: { countdownActive: boolean; panelOpen: boolean; recording: boolean }): EscapeTarget {
  if (state.countdownActive) return 'cancel-countdown';
  if (state.panelOpen) return 'close-panel';
  if (state.recording) return 'stop-recording';
  return null;
}

export function dispatchShortcut(action: ShortcutAction, a: ShortcutActions): void {
  switch (action.type) {
    case 'persona': a.setPersona(action.persona); break;
    case 'toggle-base': a.toggleBase(); break;
    case 'toggle-hud': a.toggleHud(); break;
    case 'toggle-record': a.toggleRecord(); break;
    case 'timed-record': a.timedRecord(); break;
    case 'snapshot': a.snapshot(); break;
    case 'toggle-director': a.toggleDirector(); break;
    case 'toggle-mirror': a.toggleMirror(); break;
    case 'toggle-fps': a.toggleFps(); break;
    case 'toggle-playback': a.togglePlayback(); break;
    case 'seek': a.seekBy(action.deltaSeconds); break;
    case 'toggle-loop': a.toggleLoop(); break;
    case 'toggle-help': a.toggleHelp(); break;
    case 'escape': a.escape(); break;
  }
}

export function keyInfoFromEvent(e: KeyboardEvent): ShortcutKeyInfo {
  const t = e.target as Partial<HTMLElement> | null;
  return {
    key: e.key,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    targetTag: (t?.tagName ?? '').toUpperCase(),
    isContentEditable: Boolean(t?.isContentEditable),
  };
}

/** Installs the window listener; returns a disposer. `getActions` is read per event so handlers stay fresh. */
export function installShortcuts(getActions: () => ShortcutActions): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const action = resolveShortcut(keyInfoFromEvent(e));
    if (!action) return;
    // Let Escape propagate to dialogs too; everything else is fully consumed.
    if (action.type !== 'escape') e.preventDefault();
    dispatchShortcut(action, getActions());
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
