/**
 * Seek slider value resolution for the file transport.
 *
 * The Seek `<input type="range">` is a controlled input whose source of truth — the store's mirrored
 * `transport.currentTime` — updates ASYNCHRONOUSLY: `transport.seek()` sets `video.currentTime`, and the
 * store only learns the new position from the element's `seeked` event (runtime `onTransport` sync).
 * Chromium dispatches `input` and then `change` synchronously for one keyboard step / pointer drag. If
 * the input keeps rendering the stale store position, React's controlled-input restore between those
 * two events puts the old value back into the DOM, the `change` event then carries the OLD value, and
 * the handler re-seeks the clip to where it was — the slider cannot move the clip at all.
 *
 * Resolution: the component remembers the user's pending `SeekIntent` and renders `intent.value` while
 * the store still reports exactly the position the seek started from (`Object.is`, so a NaN position
 * before metadata behaves). The moment the store moves — the seek landed, or playback resumed — the
 * store leads again AND the intent is SPENT (returned as null): an intent that were kept would revive
 * whenever the store later reported the base value again (Home from 00:02 → acknowledged → `]` `]`
 * back to exactly 00:02 would show 00:00 for a clip at 00:02; same after source replacement or loop
 * progression). Clamping to the clip range stays the caller's job.
 */
export interface SeekIntent {
  /** Position (seconds) the user asked for. */
  value: number;
  /** Store position at the moment of the request. */
  base: number;
}

export interface ResolvedSeek {
  /** Position the slider renders. */
  shown: number;
  /** The intent the component must keep for the next render: the same object while pending, null once spent. */
  intent: SeekIntent | null;
}

export function resolveSeekIntent(storeTime: number, intent: SeekIntent | null): ResolvedSeek {
  if (intent === null) return { shown: storeTime, intent: null };
  if (Object.is(storeTime, intent.base)) return { shown: intent.value, intent };
  return { shown: storeTime, intent: null };
}
