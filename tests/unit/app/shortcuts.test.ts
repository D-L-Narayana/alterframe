import { describe, it, expect, vi } from 'vitest';
import { resolveShortcut, dispatchShortcut, resolveEscape, SHORTCUT_MAP, type ShortcutActions } from '@/app/shortcuts';

const key = (k: string, extra: Partial<Parameters<typeof resolveShortcut>[0]> = {}) => ({
  key: k, ctrlKey: false, metaKey: false, altKey: false, targetTag: 'BODY', isContentEditable: false, ...extra,
});

const mockActions = (): ShortcutActions => ({
  setPersona: vi.fn(), toggleBase: vi.fn(), toggleHud: vi.fn(), toggleRecord: vi.fn(), snapshot: vi.fn(),
  toggleDirector: vi.fn(), toggleMirror: vi.fn(), toggleFps: vi.fn(), toggleHelp: vi.fn(), escape: vi.fn(),
  timedRecord: vi.fn(), togglePlayback: vi.fn(), seekBy: vi.fn(), toggleLoop: vi.fn(),
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

  it('maps the v0.2 keys: T timed recording, P play/pause, [ ] seek, L loop', () => {
    expect(resolveShortcut(key('t'))).toEqual({ type: 'timed-record' });
    expect(resolveShortcut(key('T'))).toEqual({ type: 'timed-record' });
    expect(resolveShortcut(key('p'))).toEqual({ type: 'toggle-playback' });
    expect(resolveShortcut(key('P'))).toEqual({ type: 'toggle-playback' });
    expect(resolveShortcut(key('['))).toEqual({ type: 'seek', deltaSeconds: -1 });
    expect(resolveShortcut(key(']'))).toEqual({ type: 'seek', deltaSeconds: 1 });
    expect(resolveShortcut(key('l'))).toEqual({ type: 'toggle-loop' });
    expect(resolveShortcut(key('L'))).toEqual({ type: 'toggle-loop' });
  });

  it('ignores keys while typing in inputs or with modifiers (except Escape)', () => {
    expect(resolveShortcut(key('1', { targetTag: 'INPUT' }))).toBeNull();
    expect(resolveShortcut(key('b', { targetTag: 'TEXTAREA' }))).toBeNull();
    expect(resolveShortcut(key('b', { targetTag: 'SELECT' }))).toBeNull();
    expect(resolveShortcut(key('b', { isContentEditable: true }))).toBeNull();
    expect(resolveShortcut(key('r', { ctrlKey: true }))).toBeNull();
    expect(resolveShortcut(key('r', { metaKey: true }))).toBeNull();
    expect(resolveShortcut(key('[', { targetTag: 'INPUT' }))).toBeNull();
    expect(resolveShortcut(key('p', { altKey: true }))).toBeNull();
    expect(resolveShortcut(key('Escape', { targetTag: 'INPUT' }))).toEqual({ type: 'escape' });
  });

  it('dispatches to the matching action handler', () => {
    const actions = mockActions();
    dispatchShortcut({ type: 'persona', persona: 'suit' }, actions);
    expect(actions.setPersona).toHaveBeenCalledWith('suit');
    dispatchShortcut({ type: 'toggle-record' }, actions);
    expect(actions.toggleRecord).toHaveBeenCalledOnce();
    dispatchShortcut({ type: 'escape' }, actions);
    expect(actions.escape).toHaveBeenCalledOnce();
    dispatchShortcut({ type: 'timed-record' }, actions);
    expect(actions.timedRecord).toHaveBeenCalledOnce();
    dispatchShortcut({ type: 'toggle-playback' }, actions);
    expect(actions.togglePlayback).toHaveBeenCalledOnce();
    dispatchShortcut({ type: 'seek', deltaSeconds: -1 }, actions);
    dispatchShortcut({ type: 'seek', deltaSeconds: 1 }, actions);
    expect(actions.seekBy).toHaveBeenNthCalledWith(1, -1);
    expect(actions.seekBy).toHaveBeenNthCalledWith(2, 1);
    dispatchShortcut({ type: 'toggle-loop' }, actions);
    expect(actions.toggleLoop).toHaveBeenCalledOnce();
  });

  it('exposes a human-readable map for the help dialog covering every key', () => {
    expect(SHORTCUT_MAP.length).toBeGreaterThanOrEqual(10);
    expect(SHORTCUT_MAP.find((s) => s.keys.includes('R'))?.label).toMatch(/record/i);
    const keys = new Set(SHORTCUT_MAP.flatMap((s) => s.keys));
    for (const k of ['1', '2', '3', 'B', 'H', 'R', 'S', 'T', 'D', 'M', 'F', 'P', '[', ']', 'L', '?', 'Esc']) expect(keys.has(k), k).toBe(true);
    expect(SHORTCUT_MAP.find((s) => s.keys.includes('T'))?.label).toMatch(/timer|timed/i);
    expect(SHORTCUT_MAP.find((s) => s.keys.includes('Esc'))?.label).toMatch(/countdown/i);
  });
});

describe('resolveEscape (priority: cancel countdown → close panel → stop recording)', () => {
  it('cancels a countdown first, even with a panel open and a recording running', () => {
    expect(resolveEscape({ countdownActive: true, panelOpen: true, recording: true })).toBe('cancel-countdown');
    expect(resolveEscape({ countdownActive: true, panelOpen: false, recording: false })).toBe('cancel-countdown');
  });
  it('closes an open panel before stopping a recording', () => {
    expect(resolveEscape({ countdownActive: false, panelOpen: true, recording: true })).toBe('close-panel');
    expect(resolveEscape({ countdownActive: false, panelOpen: true, recording: false })).toBe('close-panel');
  });
  it('stops a recording when nothing else is open, else does nothing', () => {
    expect(resolveEscape({ countdownActive: false, panelOpen: false, recording: true })).toBe('stop-recording');
    expect(resolveEscape({ countdownActive: false, panelOpen: false, recording: false })).toBeNull();
  });
});
