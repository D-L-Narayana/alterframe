import { createHash } from 'node:crypto';
import type { PersonaCanvasFactory, PersonaCanvasLike } from '../../../src/render/persona/canvas';

/*
 * Recording canvas factory for the persona layer tests. Every 2D-context METHOD CALL (name +
 * arguments, numbers rounded to 3 decimals) and every PROPERTY SET (name + raw value) is appended,
 * in order, to the log of the canvas that owns the context. Gradients returned by
 * createLinearGradient/createRadialGradient record their addColorStop calls under a per-gradient
 * token; createPattern returns a token; measureText answers { width: 10 }. No pixels are produced,
 * so the recorded sequence is a complete, deterministic description of what a frame paints.
 */

export type Primitive = string | number | boolean | null;

export type RecordedEntry =
  | { kind: 'call'; name: string; args: Primitive[] }
  | { kind: 'set'; name: string; value: Primitive };

export interface RecordingCanvas extends PersonaCanvasLike {
  log: RecordedEntry[];
}

/** Round to 3 decimals, normalising -0 to 0 so `toEqual` never trips on a signed zero. */
export const round3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

function normalise(v: unknown, round: boolean): Primitive {
  if (typeof v === 'number') return Number.isFinite(v) ? (round ? round3(v) : v) : String(v);
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && '__token' in v) return String((v as { __token: unknown }).__token);
  return `[${typeof v}]`;
}

export function recordingCanvasFactory(): {
  factory: PersonaCanvasFactory;
  canvases: RecordingCanvas[];
  /** The ordered log of the canvas (empty for canvases this factory did not create). */
  logOf(c: PersonaCanvasLike): RecordedEntry[];
} {
  const canvases: RecordingCanvas[] = [];
  let tokens = 0;
  const factory: PersonaCanvasFactory = (w, h) => {
    const log: RecordedEntry[] = [];
    const call = (name: string, args: unknown[]) => { log.push({ kind: 'call', name, args: args.map((a) => normalise(a, true)) }); };
    const gradient = (name: string, args: unknown[]) => {
      const token = `${name}#${++tokens}`;
      call(name, args);
      return {
        __token: token,
        addColorStop: (offset: number, color: string) => { call(`${token}.addColorStop`, [offset, color]); },
      };
    };
    const canvas: RecordingCanvas = { width: w, height: h, log, getContext: () => ctx };
    const ctx = new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'canvas') return canvas;
        if (prop === 'measureText') return (text: string) => { call(prop, [text]); return { width: 10 }; };
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createConicGradient') return (...args: unknown[]) => gradient(prop, args);
        if (prop === 'createPattern') return (...args: unknown[]) => { call(prop, args); return { __token: `pattern#${++tokens}` }; };
        return (...args: unknown[]) => { call(prop, args); return undefined; };
      },
      set: (_t, prop, value) => {
        if (typeof prop === 'string') log.push({ kind: 'set', name: prop, value: normalise(value, false) });
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    canvases.push(canvas);
    return canvas;
  };
  return { factory, canvases, logOf: (c) => (c as Partial<RecordingCanvas>).log ?? [] };
}

/** `name(arg,arg)` for calls, `name=value` for property sets — readable diffs. */
export const formatEntry = (e: RecordedEntry): string =>
  e.kind === 'call' ? `${e.name}(${e.args.map(String).join(',')})` : `${e.name}=${String(e.value)}`;

/** SHA-256 of the sequence with every number rounded to 3 decimals (compact hard-coded expectation). */
export function sequenceDigest(entries: readonly RecordedEntry[]): string {
  const json = JSON.stringify(entries, (_k, v: unknown) => (typeof v === 'number' ? round3(v) : v));
  return createHash('sha256').update(json).digest('hex');
}

/** Values assigned to a context property, in order. */
export const setsOf = (entries: readonly RecordedEntry[], name: string): Primitive[] =>
  entries.flatMap((e) => (e.kind === 'set' && e.name === name ? [e.value] : []));

/** Calls of a given method, in order. */
export const callsNamed = (entries: readonly RecordedEntry[], name: string): Primitive[][] =>
  entries.flatMap((e) => (e.kind === 'call' && e.name === name ? [e.args] : []));

/** Entries recorded after the first call of `name` (e.g. everything painted after the clear). */
export function entriesAfterCall(entries: readonly RecordedEntry[], name: string): RecordedEntry[] {
  const i = entries.findIndex((e) => e.kind === 'call' && e.name === name);
  return i < 0 ? [] : entries.slice(i + 1);
}
