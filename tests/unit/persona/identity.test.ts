import { describe, it, expect } from 'vitest';
import { createPersonaLayer } from '../../../src/render/persona';
import { DEFAULT_LOOK, type PersonaId, type SceneState } from '../../../src/types';
import { makeFace, makeFrame } from './fixtures';
import { recordingCanvasFactory, sequenceDigest, setsOf, callsNamed, type RecordedEntry } from './recorder';

/*
 * IDENTITY GUARD. At default settings the persona layer must paint exactly what v0.1 painted.
 * The recorded draw-call sequence (every 2D method call with its arguments and every property
 * set, in order) for the reference frame — face centred at x 0.5, eye openness 0.98, default look,
 * t = 0 — is pinned by its SHA-256 digest, entry count and the list of globalAlpha assignments, all
 * captured from the v0.1 code BEFORE any v0.2 change. The same sequence must come out of
 * `update(frame, scene, t)` without a look argument and of `update(frame, scene, t, DEFAULT_LOOK)`.
 * Environment: Node (vitest), recording context — no pixels, no canvas backend involved.
 */

const SIZE = { width: 640, height: 360 };
const PERSONAS: readonly PersonaId[] = ['portrait', 'masked', 'suit'];
const scene = (persona: PersonaId): SceneState => ({ base: 'live', persona, hudTint: 'white' });

interface Painted { overlay: RecordedEntry[]; backdrop: RecordedEntry[] }

function paint(persona: PersonaId, t: number, mode: 'no-look' | 'default-look'): Painted {
  const rec = recordingCanvasFactory();
  const layer = createPersonaLayer({ createCanvas: rec.factory, reducedMotion: false, seed: 5 });
  layer.resize(SIZE);
  const frame = makeFrame(makeFace({ cx: 0.5, eyeOpen: 0.98 }), t);
  if (mode === 'default-look') layer.update(frame, scene(persona), t, DEFAULT_LOOK);
  else layer.update(frame, scene(persona), t);
  return { overlay: rec.logOf(layer.overlay), backdrop: rec.logOf(layer.backdrop) };
}

const summary = (p: Painted) => ({
  overlay: { entries: p.overlay.length, sha256: sequenceDigest(p.overlay), alphas: setsOf(p.overlay, 'globalAlpha') },
  backdrop: { entries: p.backdrop.length, sha256: sequenceDigest(p.backdrop) },
});

/** Captured from the v0.1 persona layer (commit eab0e99 + contract v1.2.0 types only), seed 5, 640×360, t = 0. */
const EXPECTED_T0: Record<PersonaId, ReturnType<typeof summary>> = {
  portrait: {
    // blush ×2 (alpha 1, gradient carries the tint), eye accents ×2 (0.85 iris, 0.95 / 0.8 highlights, 0.9 lid line), lips 0.55
    overlay: { entries: 117, sha256: 'c34fb37a544aa37559107d27639ec506a39758cffac11e3eed54576346514b60', alphas: [1, 1, 1, 0.85, 0.95, 0.8, 0.9, 0.85, 0.95, 0.8, 0.9, 0.55] },
    backdrop: { entries: 1293, sha256: 'e4dc12cb27d2084c36defba563433b19bd8c0401fc88e770a5e48004ab7fac46' },
  },
  masked: {
    // mask body 0.92, rim 0.5, then per lens: opaque fill/outline 1 and inner highlight 0.35
    overlay: { entries: 171, sha256: '2995bcb01ceda47c22c5d4f5e3b9b441a50c05734be7d19aad4a249f2605512e', alphas: [1, 0.92, 0.5, 1, 0.35, 1, 0.35] },
    backdrop: { entries: 1327, sha256: 'b2087ac99233b5eaba6ae61585e4e44adf95f281d9f25fb73ae11cfd67574b8e' },
  },
  suit: {
    // torso at OVERLAY_MAX_ALPHA × 0.98
    overlay: { entries: 982, sha256: '2c21fee19fb98e73916bdde7df43fc4de44762e398d24649efb03a2893db3a6e', alphas: [1, 0.882] },
    backdrop: { entries: 11, sha256: '6e0c1bb54d8bcf6e35a01246dbe61cc40c8c1823eb7f577b65601c8c300b99ff' },
  },
};

/** Same frame at t = 1000 ms: the masked city has drifted by its time parallax (non-zero offsets). */
const EXPECTED_MASKED_T1000 = {
  overlay: { entries: 171, sha256: '2995bcb01ceda47c22c5d4f5e3b9b441a50c05734be7d19aad4a249f2605512e', alphas: [1, 0.92, 0.5, 1, 0.35, 1, 0.35] as (string | number | boolean | null)[] },
  backdrop: { entries: 1327, sha256: '883a91a331824893762467c4d1f3feed633bc0fb3de2117f8a3cbe1128bad9f2' },
};

describe('persona identity at default settings (face x 0.5, openness 0.98, default look)', () => {
  it('update() without a look argument paints exactly the same sequence as update(..., DEFAULT_LOOK), for every persona', () => {
    for (const persona of PERSONAS) {
      const a = paint(persona, 0, 'no-look');
      const b = paint(persona, 0, 'default-look');
      expect(a.overlay.length).toBeGreaterThan(5);
      expect(a.backdrop.length).toBeGreaterThan(5);
      expect(b.overlay).toEqual(a.overlay);
      expect(b.backdrop).toEqual(a.backdrop);
    }
  });

  for (const persona of PERSONAS) {
    it(`${persona}: matches the sequence recorded from the v0.1 code (digest, entry count, globalAlpha sets) — t = 0`, () => {
      for (const mode of ['no-look', 'default-look'] as const) {
        expect(summary(paint(persona, 0, mode)), `${persona} / ${mode}`).toEqual(EXPECTED_T0[persona]);
      }
    });
  }

  it('matches the v0.1 sequence for the drifted masked city at t = 1000 ms', () => {
    for (const mode of ['no-look', 'default-look'] as const) {
      expect(summary(paint('masked', 1000, mode)), mode).toEqual(EXPECTED_MASKED_T1000);
    }
  });

  it('every overlay paint starts with the identity transform, alpha 1 and a full clear', () => {
    for (const persona of PERSONAS) {
      const { overlay } = paint(persona, 0, 'no-look');
      const clearIdx = overlay.findIndex((e) => e.kind === 'call' && e.name === 'clearRect');
      expect(clearIdx).toBeGreaterThan(0);
      expect(callsNamed(overlay, 'clearRect')).toEqual([[0, 0, 640, 360]]);
      expect(overlay.slice(0, clearIdx)).toEqual([
        { kind: 'call', name: 'save', args: [] },
        { kind: 'call', name: 'setTransform', args: [1, 0, 0, 1, 0, 0] },
        { kind: 'set', name: 'globalCompositeOperation', value: 'source-over' },
        { kind: 'set', name: 'globalAlpha', value: 1 },
      ]);
    }
  });
});
