import { PERSONA_TOKENS } from '../../types';

/**
 * Every flat colour the persona layer paints, grouped per persona and sourced from
 * PERSONA_TOKENS so the design system stays the single source of truth.
 */
export const PERSONA_PALETTE = {
  portrait: {
    paper: PERSONA_TOKENS.paperWhite,
    ink: PERSONA_TOKENS.ink,
    highlight: PERSONA_TOKENS.lensWhite,
    blush: PERSONA_TOKENS.lensPink,
    lip: PERSONA_TOKENS.lensMagenta,
  },
  masked: {
    mask: PERSONA_TOKENS.lensWhite,
    lensOutlineA: PERSONA_TOKENS.lensMagenta,
    lensOutlineB: PERSONA_TOKENS.lensPink,
    sky: PERSONA_TOKENS.nightNavy,
    neonA: PERSONA_TOKENS.neonBlue,
    neonB: PERSONA_TOKENS.neonMagenta,
    shade: PERSONA_TOKENS.ink,
  },
  suit: {
    pink: PERSONA_TOKENS.suitPink,
    white: PERSONA_TOKENS.suitWhite,
    black: PERSONA_TOKENS.suitBlack,
    paper: PERSONA_TOKENS.paperWhite,
    halftone: PERSONA_TOKENS.ink,
  },
} as const;

/** Iris colour for the portrait eye accent (authored brown #5a3a1a). Not a token; kept here, not in the palette map. */
export const PORTRAIT_IRIS = '#5a3a1a';

/** `#rrggbb` → `rgba(r,g,b,a)`. Alpha is emitted as-is so callers can pass 0.55 etc. */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Linear blend of two `#rrggbb` colours, t in [0,1]. Used to shade tokens without inventing new hexes. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 255, vb = (pb >> shift) & 255;
    return Math.round(va + (vb - va) * t);
  };
  const to2 = (v: number) => v.toString(16).padStart(2, '0');
  return `#${to2(ch(16))}${to2(ch(8))}${to2(ch(0))}`;
}
