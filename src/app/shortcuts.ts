/**
 * Global keyboard shortcuts (W1). Pure resolution logic is separated from the DOM listener
 * so it can be unit-tested in Node. Recording/snapshot actions are wired by the App to the
 * real `RuntimeHandle` (held in a React ref) — never through the dev-only window global.
 */
import type { PersonaId } from '@/types';

export type ShortcutAction =
  | { type: 'persona'; persona: PersonaId }
  | { type: 'toggle-base' }
  | { type: 'toggle-hud' }
  | { type: 'toggle-record' }
  | { type: 'snapshot' }
  | { type: 'toggle-director' }
  | { type: 'toggle-mirror' }
  | { type: 'toggle-fps' }
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
  snapshot(): void;
  toggleDirector(): void;
  toggleMirror(): void;
  toggleFps(): void;
  toggleHelp(): void;
  escape(): void;
}

export interface ShortcutDoc { keys: string[]; label: string }

/** Shown in the Help dialog; keep in sync with `resolveShortcut`. */
export const SHORTCUT_MAP: readonly ShortcutDoc[] = [
  { keys: ['1', '2', '3'], label: 'Persona: Portrait / Masked hero / Web suit' },
  { keys: ['B'], label: 'Toggle base style (live / comic)' },
  { keys: ['H'], label: 'Toggle HUD callouts' },
  { keys: ['R'], label: 'Start / stop recording' },
  { keys: ['S'], label: 'Save a snapshot (PNG)' },
  { keys: ['D'], label: 'Director: play / stop the reel sequence' },
  { keys: ['M'], label: 'Toggle mirror' },
  { keys: ['F'], label: 'Toggle fps badge' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Close panels / stop recording' },
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
    case 's': case 'S': return { type: 'snapshot' };
    case 'd': case 'D': return { type: 'toggle-director' };
    case 'm': case 'M': return { type: 'toggle-mirror' };
    case 'f': case 'F': return { type: 'toggle-fps' };
    case '?': return { type: 'toggle-help' };
    default: return null;
  }
}

export function dispatchShortcut(action: ShortcutAction, a: ShortcutActions): void {
  switch (action.type) {
    case 'persona': a.setPersona(action.persona); break;
    case 'toggle-base': a.toggleBase(); break;
    case 'toggle-hud': a.toggleHud(); break;
    case 'toggle-record': a.toggleRecord(); break;
    case 'snapshot': a.snapshot(); break;
    case 'toggle-director': a.toggleDirector(); break;
    case 'toggle-mirror': a.toggleMirror(); break;
    case 'toggle-fps': a.toggleFps(); break;
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
