import { describe, it, expect } from 'vitest';
import { PERSONA_PALETTE, withAlpha } from '../../../src/render/persona/palette';
import { PERSONA_TOKENS } from '../../../src/types';

describe('persona palette', () => {
  it('derives every persona colour from PERSONA_TOKENS (no ad-hoc hex values)', () => {
    const tokenValues = new Set(Object.values(PERSONA_TOKENS));
    expect(PERSONA_PALETTE.portrait.paper).toBe(PERSONA_TOKENS.paperWhite);
    expect(PERSONA_PALETTE.portrait.ink).toBe(PERSONA_TOKENS.ink);
    expect(PERSONA_PALETTE.masked.mask).toBe(PERSONA_TOKENS.lensWhite);
    expect(PERSONA_PALETTE.masked.lensOutlineA).toBe(PERSONA_TOKENS.lensMagenta);
    expect(PERSONA_PALETTE.masked.lensOutlineB).toBe(PERSONA_TOKENS.lensPink);
    expect(PERSONA_PALETTE.masked.sky).toBe(PERSONA_TOKENS.nightNavy);
    expect(PERSONA_PALETTE.masked.neonA).toBe(PERSONA_TOKENS.neonBlue);
    expect(PERSONA_PALETTE.masked.neonB).toBe(PERSONA_TOKENS.neonMagenta);
    expect(PERSONA_PALETTE.suit.pink).toBe(PERSONA_TOKENS.suitPink);
    expect(PERSONA_PALETTE.suit.white).toBe(PERSONA_TOKENS.suitWhite);
    expect(PERSONA_PALETTE.suit.black).toBe(PERSONA_TOKENS.suitBlack);
    // every flat colour in the palette is a token value
    for (const group of Object.values(PERSONA_PALETTE)) {
      for (const v of Object.values(group)) expect(tokenValues.has(v)).toBe(true);
    }
  });
  it('withAlpha converts a #rrggbb token into rgba() with the given alpha', () => {
    expect(withAlpha('#ff4fb6', 0.5)).toBe('rgba(255,79,182,0.5)');
    expect(withAlpha(PERSONA_TOKENS.ink, 1)).toBe('rgba(20,18,22,1)');
  });
});
