# Changelog

All notable changes to AlterFrame. The format follows Keep a Changelog; versions follow SemVer.

## 0.2.0 — Unreleased

Theme: resilient, hands-free and transparent — without changing what the effect is. Default look and
behaviour are pixel-identical to 0.1 at default settings.

### Added

* **Loading and recovery** — determinate progressbar "Loading tracking models" (byte-level model
  download progress, ≤ 10 Hz); a failure card ("Tracking models could not be loaded") with
  **Retry tracking** (re-entrant tracker init: only the missing pieces are fetched again) and
  **Continue without tracking** (the live video keeps running); the models download in parallel with
  the camera permission prompt; a coach hint until the hand window opens the first time.
* **Hands-free capture** — Settings → Capture: Self-timer (Off/3/5/10 s) and Auto-stop
  (Off/10/15/30/60 s); the countdown is drawn inside the frame by the HUD and announced
  ("Recording starts in 3" / "Snapshot in 3") with a Cancel button; `T` starts a timed recording
  (3 s when the timer is Off; again cancels); `Esc` cancels a countdown first. The recording
  indicator shows the remaining auto-stop time.
* **Hold-still gesture** — Settings → Window & gestures → "Hold still to capture" (Off/Snapshot/
  Record) and "Hold time": keeping the window still for the hold time takes a snapshot or starts a
  recording; a ring at the corner callout shows the progress.
* **File playback controls** — `<nav aria-label="Playback">` for video-file sources with
  Play/Pause, a Seek slider (mm:ss), a Loop switch and keys `P` `[` `]` `L`; the frame re-renders
  while paused when persona, look or other settings change; with Loop off the clip ends paused.
* **Display fit** — Fill (crop, as before) or Fit (letterbox with opaque black bars; overlays and
  HUD follow the same mapping, nothing is drawn on the bars; captures include the bars).
* **Look** — Settings → Look: Ink thickness, Ink threshold, Halftone, Saturation, Colour bands,
  Grain, Overlay strength and "Reset look"; every value is a multiplier around the 0.1 constants.
* **Quality controls** — "Tracking resolution" (Full/480p/360p; frames taller than the limit are
  downscaled once before inference) and "Face every N frames"; both are also rungs of the adaptive
  ladder.
* **Diagnostics** — Settings → Diagnostics (`<dl>`: Tracking delegates GPU/CPU, Frame, Tracking
  time, Render time, GPU time, Quality, Renderer, Source) refreshed at 2 Hz, and "Copy diagnostics"
  (JSON to the clipboard, visible fallback when the Clipboard API is unavailable).
* **Persona details** — masked lenses squint with eye openness; the night-city backdrop shifts with
  head position (frozen under reduced motion); overlay strength is look-controllable.
* **Toasts** for WebGL context loss and recovery ("Graphics context lost — recovering",
  "Graphics restored"); "Thin-slit glitch" exposed as a Display setting (off by default).
* Snapshot formats JPEG and WebP (PNG fallback when the browser cannot encode them); capture aspect
  moved into Settings → Capture.
* Help dialog lists the new keys; Esc priority: cancel countdown → close panel → stop recording.

### Changed

* MediaPipe (`@mediapipe/tasks-vision`) is a **lazy chunk** imported on tracker init, so the app
  shell paints before the tracking code is fetched. Measured on the v0.2 build (Vite output, decimal
  kB): entry 387.4 kB raw / 125.1 kB gzip (react-dom ≈ 53 %), tracking chunk 170.7 kB / 52.1 kB gzip,
  total JS 177.2 kB gzip (0.1 shipped one 162.7 kB gzip chunk including MediaPipe). The bundle report
  enforces total ≤ 450 kB gz, entry ≤ 128 kB gz (measured + ≈ 2 % headroom) and a MediaPipe-free
  entry; CI runs it with `--strict`.
* Adaptive quality ladder v2: rung order `inferenceMaxHeight 720→480`, `segmentationStride 1→2`,
  `faceStride 1→2`, `renderScale 1→0.85→0.7`, `inferenceMaxHeight →360`, `segmentationStride →3`,
  `renderScale →0.55→0.5`, `faceStride →3`; cost-aware: when rendering dominates the frame time the
  next render-scale rung is taken first; restore in exact reverse order.
* Shader programs are warmed up in idle time after start; the renderer reports `gpuMs` from the
  WebGL2 timer-query extension when available (null otherwise).
* Recordings are capped at 10 minutes (the result is kept and downloaded); a recording in progress is
  finalised and saved when leaving the stage or switching sources.
* Corner smoothing (optional critically damped spring) is a setting (0 = off, exact fingertips).
* Settings persistence envelope bumped to v2 (still memory-only); contract `CONTRACT_VERSION` 1.2.0
  (additive, see `docs/contract-changes.md`).

### Fixed

* Camera-denied and model-failure states no longer leave an indeterminate loading bar behind.
* Switching sources while recording no longer discards the recording.
* MediaPipe's built-in usage logger (a POST to a Google endpoint 60 s after each task starts) is
  blocked locally by a telemetry guard in the tracking module; it was already blocked by the deployed
  `connect-src 'self'`, but produced CSP violation reports and would have fired on hosts without the
  headers. No data left the device in either case (`docs/security.md`).
* Seek slider (file playback): a controlled range input re-seeked the clip to its previous position —
  Chromium dispatches `input` then `change` synchronously and React restored the stale store value
  between them; the slider now renders the pending seek intent until the store acknowledges it, and
  the intent is spent once acknowledged so it can never revive when the clip returns to the same
  position (`src/app/transportSlider.ts`, `tests/unit/app/transportSlider.test.ts`, e2e
  `transport.spec.ts` asserts a real nonzero→0 Home seek and the no-revival case).
* File transport latency: `play()`, `pause()` and `seek()` now publish the element state to the store
  in the same task as the command (the element's `play`/`pause`/`seeked` events still re-notify with
  the settled values), so the Play/Pause label, the slider and the time readout no longer wait for the
  next inference frame on a busy main thread (`src/media/fileSource.ts`,
  `tests/unit/media/transport.test.ts`).
* Loading e2e helper: progress is read in one browser-side step (`readLoadingProgress`), removing a
  count-then-attribute race that autowaited on a removed progress bar.

### Infra

* `scripts/serve-dist.mjs`: zero-dependency production-like server applying the `vercel.json`
  headers, rewrites, clean URLs and content types; `scripts/with-server.mjs` runs a command against
  it. `npm run serve:dist`, `npm run test:prod-gate`.
* Production gate extended: CSP-violation capture and a foreign-request log (0 violations, 0 requests
  to other origins across onboarding → camera → settings → recording with the real tracking runtime,
  plus 65 s idle) and live header assertions; CI `prod-gate` job on the built `dist`.
* CSP tightened to `style-src 'self'` (no `'unsafe-inline'`), evidence-based (`docs/security.md`).
* New e2e specs: loading, capture-timer, transport (in-browser WebM fixture), fit, look, dwell,
  diagnostics; a11y extended to the failure card and transport; CI runs the GPU pixel suite with
  Chromium; fixture clips cached; advisory `npm audit` job.
* `scripts/bundle-report.mjs`: per-chunk table, entry-chunk budget, MediaPipe-in-entry check,
  `--strict`.
* Hygiene rules: no `*.log` files, no absolute home-directory paths, no references to retired
  internal planning documents outside `docs/handoffs/`; two stray log files removed.
* Docs: README, architecture, testing, security, release, verification (protocol + template, no
  private paths), the new `docs/modules.md` module guide and this changelog.

## 0.1.0 — 2026-10-02

First public release: hand-window alter-ego effect with three personas, live/comic base, HUD
callouts, hands-together persona cycle, Director sequence, WebM/MP4 recording and PNG snapshots,
camera-denied file fallback, memory-only settings, strict CSP deployment on Vercel.
