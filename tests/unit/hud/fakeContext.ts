import type { Hud2D } from '../../../src/hud/draw';

export interface Call { op: string; args: number[] | string[]; state: Record<string, unknown> }

/**
 * Minimal recording stand-in for CanvasRenderingContext2D. Records every drawing
 * op together with a snapshot of the style state at the time of the call so tests
 * can assert on colour/alpha/font without a real canvas (Node has none).
 */
export function createFakeContext(glyphWidth = 10) {
  const calls: Call[] = [];
  const stack: Record<string, unknown>[] = [];
  const state: Record<string, unknown> = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter', letterSpacing: '0px',
  };
  const rec = (op: string, ...args: number[] | string[]) => { calls.push({ op, args, state: { ...state } }); };
  const target: Record<string, unknown> = {
    clearRect: (...a: number[]) => rec('clearRect', ...a),
    save: () => { stack.push({ ...state }); rec('save'); },
    restore: () => { const s = stack.pop(); if (s) Object.assign(state, s); rec('restore'); },
    beginPath: () => rec('beginPath'),
    closePath: () => rec('closePath'),
    moveTo: (...a: number[]) => rec('moveTo', ...a),
    lineTo: (...a: number[]) => rec('lineTo', ...a),
    stroke: () => rec('stroke'),
    fill: () => rec('fill'),
    arc: (...a: number[]) => rec('arc', ...a),
    rect: (...a: number[]) => rec('rect', ...a),
    strokeRect: (...a: number[]) => rec('strokeRect', ...a),
    fillRect: (...a: number[]) => rec('fillRect', ...a),
    fillText: (text: string, x: number, y: number) => { calls.push({ op: 'fillText', args: [text, String(x), String(y)], state: { ...state } }); },
    measureText: (text: string) => ({ width: text.length * glyphWidth }),
  };
  const ctx = new Proxy(target, {
    get(t, prop: string) { return prop in t ? t[prop] : state[prop]; },
    set(_t, prop: string, value: unknown) { state[prop] = value; return true; },
  }) as unknown as Hud2D;
  return { ctx, calls };
}

export const ops = (calls: Call[], op: string) => calls.filter((c) => c.op === op);
