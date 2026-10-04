/**
 * HUD code generation.
 *
 * The source footage shows 7-digit codes whose last five digits are fixed per anchor
 * (`10100` corner, `10301` first eye, `10502` second eye) while the two leading
 * digits re-roll every ~0.8 s in a non-monotonic way. We reproduce that with a
 * deterministic integer hash of the 800 ms time slot and a seed, so unit tests
 * and visual baselines are reproducible.
 */

export const PREFIX_PERIOD_MS = 800;

export const CODE_SUFFIX = {
  corner: '10100',
  'eye-left': '10301',
  'eye-right': '10502',
  'hand-left': '10704',
  'hand-right': '10905',
} as const;

export type CodeAnchorId = keyof typeof CODE_SUFFIX;

/** 32-bit integer mix (lowbias32 by Chris Wellons, public domain). */
function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Two-digit prefix ("10".."99") for time `t` (ms) and `seed`.
 * Same slot ⇒ same prefix; different slot ⇒ pseudo-random new prefix.
 */
export function codePrefix(t: number, seed = 0): string {
  const slot = Number.isFinite(t) ? Math.floor(t / PREFIX_PERIOD_MS) : 0;
  // Combine slot and seed; the golden-ratio constant decorrelates adjacent slots.
  const h = mix32((slot * 0x9e3779b1) ^ mix32(seed + 0x51ed270b));
  const n = 10 + (h % 90); // 10..99 — never a leading zero, always 2 digits
  return String(n);
}

export function buildCode(prefix: string, id: CodeAnchorId): string {
  return prefix + CODE_SUFFIX[id];
}
