import { describe, it, expect, vi } from 'vitest';
import { resolveShortcut, dispatchShortcut, SHORTCUT_MAP, type ShortcutActions } from '@/app/shortcuts';

const key = (k: string, extra: Partial<Parameters<typeof resolveShortcut>[0]> = {}) => ({
  key: k, ctrlKey: false, metaKey: false, altKey: false, targetTag: 'BODY', isContentEditable: false, ...extra,
});

describe('resolveShortcut', () => {
  it('maps every documented key', () => {
    expect(resolveShortcut(key('1'))).toEqual({ type: 'persona', persona: 'portrait' });
    expect(resolveShortcut(key('2'))).toEqual({ type: 'persona', persona: 'masked' });
    expect(resolveShortcut(key('3'))).toEqual({ type: 'persona', persona: 'suit' });
    expect(resolveShortcut(key('b'))).toEqual({ type: 'toggle-base' });
    expect(resolveShortcut(key('B'))).toEqual({ type: 'toggle-base' });
    expect(resolveShortcut(key('h'))).toEqual({ type: 'toggle-hud' });
    expect(resolveShortcut(key('r'))).toEqual({ type: 'toggle-record' });
    expect(resolveShortcut(key('s'))).toEqual({ type: 'snapshot' });
    expect(resolveShortcut(key('d'))).toEqual({ type: 'toggle-director' });
    expect(resolveShortcut(key('m'))).toEqual({ type: 'toggle-mirror' });
    expect(resolveShortcut(key('f'))).toEqual({ type: 'toggle-fps' });
    expect(resolveShortcut(key('?'))).toEqual({ type: 'toggle-help' });
    expect(resolveShortcut(key('Escape'))).toEqual({ type: 'escape' });
    expect(resolveShortcut(key('x'))).toBeNull();
  });

  it('ignores keys while typing in inputs or with modifiers (except Escape)', () => {
    expect(resolveShortcut(key('1', { targetTag: 'INPUT' }))).toBeNull();
    expect(resolveShortcut(key('b', { targetTag: 'TEXTAREA' }))).toBeNull();
    expect(resolveShortcut(key('b', { targetTag: 'SELECT' }))).toBeNull();
    expect(resolveShortcut(key('b', { isContentEditable: true }))).toBeNull();
    expect(resolveShortcut(key('r', { ctrlKey: true }))).toBeNull();
    expect(resolveShortcut(key('r', { metaKey: true }))).toBeNull();
    expect(resolveShortcut(key('Escape', { targetTag: 'INPUT' }))).toEqual({ type: 'escape' });
  });

  it('dispatches to the matching action handler', () => {
    const actions: ShortcutActions = {
      setPersona: vi.fn(), toggleBase: vi.fn(), toggleHud: vi.fn(), toggleRecord: vi.fn(), snapshot: vi.fn(),
      toggleDirector: vi.fn(), toggleMirror: vi.fn(), toggleFps: vi.fn(), toggleHelp: vi.fn(), escape: vi.fn(),
    };
    dispatchShortcut({ type: 'persona', persona: 'suit' }, actions);
    expect(actions.setPersona).toHaveBeenCalledWith('suit');
    dispatchShortcut({ type: 'toggle-record' }, actions);
    expect(actions.toggleRecord).toHaveBeenCalledOnce();
    dispatchShortcut({ type: 'escape' }, actions);
    expect(actions.escape).toHaveBeenCalledOnce();
  });

  it('exposes a human-readable map for the help dialog', () => {
    expect(SHORTCUT_MAP.length).toBeGreaterThanOrEqual(10);
    expect(SHORTCUT_MAP.find((s) => s.keys.includes('R'))?.label).toMatch(/record/i);
  });
});
