/**
 * Playback controls for file sources: `<nav aria-label="Playback">` with Play/Pause, a Seek slider
 * (mm:ss value text) and a Loop switch. State comes from `session.transport` (mirrored by the
 * runtime); commands go to the live `FileTransport` read on demand through `getTransport`.
 */
import { useState } from 'react';
import type { FileTransport, TransportState } from '@/types';
import { useUiStore } from '@/state/uiStore';
import { IconButton, PauseIcon, PlayIcon, Toggle } from '@/ui';
import { formatSeconds } from './format';
import { resolveSeekIntent, type SeekIntent } from './transportSlider';

export interface TransportProps {
  state: TransportState;
  getTransport(): FileTransport | null;
}

export function Transport({ state, getTransport }: TransportProps) {
  // The user's pending seek: rendered until the (asynchronously mirrored) store position moves.
  const [intent, setIntent] = useState<SeekIntent | null>(null);
  const resolved = resolveSeekIntent(state.currentTime, intent);
  // Render-phase adjustment (React's "storing information from previous renders" pattern): once the
  // store has moved, the intent is spent and must be dropped, otherwise it would revive — showing the
  // old request again — whenever the store later reports the same base position (e.g. Home from
  // 00:02 → acknowledged → `]` `]` back to exactly 00:02). Guarded by the inequality, so it cannot loop.
  if (resolved.intent !== intent) setIntent(resolved.intent);
  const duration = Number.isFinite(state.duration) && state.duration > 0 ? state.duration : 0;
  const shown = Math.min(duration, Math.max(0, Number.isFinite(resolved.shown) ? resolved.shown : 0));
  const act = (fn: (t: FileTransport) => void) => {
    const t = getTransport();
    if (t) fn(t);
  };
  const togglePlay = () =>
    act((t) => {
      if (!t.paused) {
        t.pause();
        return;
      }
      void t.play().then((ok) => {
        if (!ok) useUiStore.getState().notify('Playback was blocked by the browser.', 'error');
      });
    });

  return (
    <nav className="af-transport" aria-label="Playback">
      <IconButton label={state.paused ? 'Play' : 'Pause'} shortcut="P" icon={state.paused ? <PlayIcon /> : <PauseIcon />} onClick={togglePlay} />
      <input
        type="range"
        className="af-slider__input af-transport__seek"
        aria-label="Seek"
        min={0}
        max={duration}
        step={0.1}
        value={shown}
        aria-valuetext={formatSeconds(shown)}
        disabled={duration === 0}
        onChange={(e) => {
          const seconds = Number(e.currentTarget.value);
          // Chromium dispatches `input` then `change` synchronously for one key step / pointer drag. The
          // store learns the new position only from the element's asynchronous `seeked` event, so without
          // the pending intent React's controlled-value restore would put the STALE position back into the
          // DOM between the two events and the `change` handler would re-seek the clip to where it was.
          // React flushes the state update inside the discrete event before restoring, so the DOM keeps
          // `seconds`; should the `change` event still reach us with the same request, it is a no-op here
          // instead of a second seek.
          if (intent !== null && intent.value === seconds && Object.is(intent.base, state.currentTime)) return;
          setIntent({ value: seconds, base: state.currentTime });
          act((t) => t.seek(seconds));
        }}
      />
      <span className="af-transport__time" aria-hidden="true">
        {formatSeconds(shown)} / {formatSeconds(duration)}
      </span>
      <Toggle label="Loop" checked={state.loop} onChange={(loop) => act((t) => t.setLoop(loop))} />
    </nav>
  );
}
