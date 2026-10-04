/**
 * Seek slider value resolution (pure). A controlled range input whose source of truth (the store's
 * mirrored transport position) updates asynchronously must keep showing the user's pending seek
 * intent until the store moves — otherwise React's controlled-input restore between the browser's
 * `input` and `change` events re-seeks the clip to the stale position — and must SPEND the intent on
 * acknowledgement, otherwise the request revives whenever the store later reports the base value again
 * (clip at 00:02 shown as 00:00 after Home → `]` `]`).
 */
import { describe, it, expect } from 'vitest';
import { resolveSeekIntent, type SeekIntent } from '@/app/transportSlider';

describe('resolveSeekIntent', () => {
  it('follows the store when there is no pending intent', () => {
    expect(resolveSeekIntent(1.4, null)).toEqual({ shown: 1.4, intent: null });
    expect(resolveSeekIntent(0, null)).toEqual({ shown: 0, intent: null });
  });

  it('shows the intent and keeps the same object while the store still reports the base (pending)', () => {
    const intent: SeekIntent = { value: 0, base: 1.4 };
    const r = resolveSeekIntent(1.4, intent);
    expect(r.shown).toBe(0);
    expect(r.intent).toBe(intent);
    const forward: SeekIntent = { value: 1.9, base: 0.3 };
    expect(resolveSeekIntent(0.3, forward)).toEqual({ shown: 1.9, intent: forward });
  });

  it('spends the intent once the seek landed on the requested position (store leads, intent null)', () => {
    expect(resolveSeekIntent(0, { value: 0, base: 1.4 })).toEqual({ shown: 0, intent: null });
    expect(resolveSeekIntent(1.9, { value: 1.9, base: 0.3 })).toEqual({ shown: 1.9, intent: null });
  });

  it('spends the intent when the store moved elsewhere (playback resumed, seek clamped)', () => {
    expect(resolveSeekIntent(1.65, { value: 0, base: 1.4 })).toEqual({ shown: 1.65, intent: null });
    expect(resolveSeekIntent(2, { value: 5, base: 1.4 })).toEqual({ shown: 2, intent: null });
  });

  it('sequence: pending → acknowledged → the store returning to the old base does NOT revive the request', () => {
    const intent: SeekIntent = { value: 0, base: 1.4 };
    const r1 = resolveSeekIntent(1.4, intent); // Home pressed while paused at 1.4
    expect(r1.shown).toBe(0);
    expect(r1.intent).toBe(intent);
    const r2 = resolveSeekIntent(0, r1.intent); // `seeked` → store 0: acknowledged
    expect(r2.shown).toBe(0);
    expect(r2.intent).toBeNull();
    const r3 = resolveSeekIntent(1.4, r2.intent); // `]` `]` bring the store back to exactly 1.4
    expect(r3).toEqual({ shown: 1.4, intent: null });
  });

  it('documents the component contract: an intent kept after acknowledgement would revive, so the resolver spends it', () => {
    expect(resolveSeekIntent(0, { value: 0, base: 1.4 }).intent).toBeNull();
    // What a stale (unspent) intent does when it is fed back in: the old request wins — hence spending.
    expect(resolveSeekIntent(1.4, { value: 0, base: 1.4 }).shown).toBe(0);
  });

  it('compares with Object.is: a NaN base (metadata pending) stays pending while the store is NaN and is spent at 0.5', () => {
    const intent: SeekIntent = { value: 0.5, base: Number.NaN };
    const pending = resolveSeekIntent(Number.NaN, intent);
    expect(pending.shown).toBe(0.5);
    expect(pending.intent).toBe(intent);
    expect(resolveSeekIntent(0.5, intent)).toEqual({ shown: 0.5, intent: null });
    expect(resolveSeekIntent(0.7, intent)).toEqual({ shown: 0.7, intent: null });
    // -0 and 0 differ under Object.is: a store at -0 is not "still at base 0" → spent.
    expect(resolveSeekIntent(-0, { value: 1, base: 0 })).toEqual({ shown: -0, intent: null });
  });

  it('does not clamp: range limits stay the caller’s job', () => {
    expect(resolveSeekIntent(1.4, { value: 99, base: 1.4 }).shown).toBe(99);
    expect(resolveSeekIntent(1.4, { value: -3, base: 1.4 }).shown).toBe(-3);
  });
});
