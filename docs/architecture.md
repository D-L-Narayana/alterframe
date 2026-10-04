# Architecture

AlterFrame is a single-page Vite + React 19 app with a per-frame runtime loop that feeds raw
WebGL2. There is no backend; models and wasm are static files served from the same origin.
Module-by-module APIs and conventions are in [`modules.md`](modules.md); the shared contracts are
the types in `src/types/**` (`CONTRACT_VERSION` 1.2.0).

```
┌─ React UI (src/app, src/ui, src/state) ───────────────────────────────────────┐
│ Onboarding → Stage (canvas) + loading bar / failure card / coach hint /        │
│ countdown / file transport → Controls → Settings (incl. Diagnostics) → Help    │
│ zustand store: settings / scene / session (memory only)                        │
└───────────────┬────────────────────────────────────────────────────────────────┘
                │ startRuntime({ canvas, store, source })   (src/runtime, per video frame)
                ▼
 FrameSource (src/media) ──video──▶ Tracker (src/tracking, LAZY chunk: hands, face, segmentation)
   ──TrackingFrame──▶ Interaction (src/interaction: WindowQuad, gestures, dwell, Director)
   ──quad / scene──▶ PersonaLayer (src/render/persona, overlay + backdrop canvases) ─┐
                    Hud (src/hud, 2D canvas; countdown numeral, dwell ring) ───────┼──▶ Renderer (src/render/core)
                    StylePresets (src/render/shaders + styles.ts, look-driven) ─────┘        │ cover / contain present
                                                                                             ▼
                                                 composited <canvas> ──▶ Recorder / Snapshot (src/capture)
                                                 PerfMonitor + AdaptiveQuality (src/perf) → store.quality
```

## Per-frame pipeline

1. `FrameSource.onFrame` (requestVideoFrameCallback, rAF fallback) fires with the video time.
   While a file source is paused the runtime re-renders once per burst of store changes
   (`requestRender`, debounced to one animation frame) so persona/look/fit changes show immediately.
2. `Tracker.update(video, t)` → `TrackingFrame` (0–2 hands with 21 landmarks each, face with 478
   landmarks + blendshapes, 256×256 person-confidence mask). Landmarks are One-Euro smoothed and
   already mirrored into **normalized display space** (`src/types/geometry.ts`): x,y ∈ [0,1],
   origin top-left, screen-left ≈ 0. Frames taller than `quality.inferenceMaxHeight` are downscaled
   once into an internal canvas before inference; the face landmarker runs every
   `quality.faceStride` frames (the last face object is reused in between).
3. `Interaction.update` → `WindowQuad` (TL,TR,BR,BL from index/thumb tips, hold/fade opacity,
   thickness, area; optional critically damped corner spring) + events (`window-open/close`,
   optional `cycle-persona`, `dwell` when both hands held the window still for `dwellMs`).
   `dwell` becomes a `session.captureRequest` the app performs (snapshot or record) and clears.
4. `Director.update(t)` (when running) overrides the scene.
5. `PersonaLayer.update(frame, scene, t, look)` redraws overlay/backdrop canvases only when inputs
   change (`__dirty`); `look.overlayStrength` scales the overlay alpha.
6. `Hud.buildModel(frame, quad, scene, t, extras)` (pure) → `Hud.draw`. Extras carry the self-timer
   (`countdown`, drawn as a centred numeral even with callouts off) and `dwellProgress` (ring at the
   corner callout).
7. `Renderer.render(inputs)`:
   * upload video (UV-flipped when mirrored) and mask textures;
   * **base layer**: live video or the comic chain without the backdrop pass;
   * **window layer**: persona preset passes with `u_backdrop` = persona backdrop, then the persona
     overlay composited with normal alpha; pass uniforms are derived from `inputs.look`
     (`DEFAULT_LOOK` reproduces the 0.1 constants exactly);
   * quad mask drawn as two triangles with `quad.opacity`; optional thin-slit glitch (setting, default off);
   * `out = mix(base, window, quadMask)`; HUD composited last;
   * **one** fit mapping from video-frame space to the canvas in the present pass: `cover` (crop,
     default) or `contain` (letterbox, bars painted opaque black; overlays and HUD follow the same
     mapping so nothing is drawn on the bars). The recorder and snapshots read the presented canvas,
     so in Fit mode captures include the bars — by design, what you see is what you get.
     `stats.gpuMs` comes from `EXT_disjoint_timer_query_webgl2` when available (asynchronous result
     polling, `null` otherwise; under software rendering it measures CPU time).
8. `PerfMonitor.sample`; the adaptive policy may step down the quality ladder
   (`inferenceMaxHeight 720→480`, `segmentationStride 1→2`, `faceStride 1→2`, `renderScale 1→0.85→0.7`,
   `inferenceMaxHeight →360`, `segmentationStride →3`, `renderScale →0.55→0.5`, `faceStride →3`),
   taking the next render-scale rung first when the median render time exceeds the median tracking
   time; `stepUp` restores in reverse order.

Overlay canvases (persona, HUD) are sized to the **video frame**, not the CSS canvas, so every
module works in the same normalized space and the renderer applies the single fit mapping.

## Start-up and recovery

* `useRuntime` creates the source and starts the runtime **immediately**, so the tracker chunk and
  the models download while the camera permission prompt is open. Source status
  (`requesting/ready/denied/unavailable/error`) is mirrored into the session by the runtime.
* `@/tracking` (and with it `@mediapipe/tasks-vision`) is a **lazy chunk**: `createLazyTracker`
  imports it dynamically on `init()`. Until it arrives the tracker returns empty frames and buffers
  `setOptions`. `scripts/bundle-report.mjs` reports whether the entry chunk is MediaPipe-free and
  its gzip size against the entry budget. The tracking module also installs a telemetry guard that
  blocks MediaPipe's built-in usage-log request locally (`docs/security.md`).
* Model download progress is streamed by the tracker (byte-level) and written to
  `session.trackerProgress` at ≤ 10 Hz → the `progressbar` "Loading tracking models". A failure
  writes `session.trackerError` → the failure card; **Retry tracking** calls `handle.retryTracker()`
  (the tracker's `init()` is re-entrant: only the missing pieces are fetched again); **Continue
  without tracking** hides the card and the stage runs untracked.
* After `renderer.init`, `renderer.warm(ALL_PRESETS)` compiles every pass program in idle time
  (`requestIdleCallback`, `setTimeout(0)` fallback) so the first styled frame does not stall.
* WebGL context loss: the renderer suspends, rebuilds every GL object on restore; the runtime mirrors
  `session.contextLost` (toasts "Graphics context lost — recovering" / "Graphics restored") and
  invalidates the persona canvases so they repaint.

## Capture flow

`src/app/useCapture.ts` is the capture state machine: R/S/the bar buttons honour
`settings.capture.selfTimer` by writing `session.countdown` (`endsAt` in the `performance.now()`
domain; the HUD draws it, `CountdownBanner` announces it); `T` always records with a timer (3 s when
Off); R/T/Esc/"Cancel countdown" cancel; `autoStop` stops a recording and downloads it; a
`captureRequest` from the hold-still gesture is performed at once. The recorder caps a recording at
`maxDurationMs` (10 min default) and holds the result (`hasPendingResult`) for the next `stop()`;
a recording in progress is finalised and downloaded before the stage unmounts or the source
switches. Snapshots take `{ format, quality }`; the file extension follows the type the browser
actually produced (PNG fallback).

## File transport

`FileSource.transport` (`play/pause/seek/setLoop`, `paused/currentTime/duration/loop`) plus
`onTransport(cb)` events; the runtime mirrors a `TransportState` into `session.transport`
(immediately on change, and at the 250 ms session sync). `play()`, `pause()` and `seek()` publish the
element state synchronously in the same task as the command (the element's `play`/`pause`/`seeked`
events re-notify with the settled values), so the controls never wait for the next inference frame;
the Seek slider is a controlled input whose source of truth is that asynchronous mirror, so it shows
the pending request until the store acknowledges it, and a spent request never revives when the clip
later returns to the same position (`src/app/transportSlider.ts`). The `<nav aria-label="Playback">`
UI and the `P [ ] L` keys act on the live transport read on demand; camera sessions have no
transport and the keys are no-ops. With Loop off the clip ends paused.

## Diagnostics

`handle.getDiagnostics()` returns a plain `RuntimeDiagnostics` object (fps, frame/tracking/render
times, `gpuMs`, frame count, tracker readiness/progress/error/delegates/inference size/warnings,
renderer context state and internal size, quality, source). The Settings → Diagnostics group polls
it at 2 Hz while the sheet is open and **Copy diagnostics** writes the JSON to the clipboard (a
visible `<pre>` fallback appears when the Clipboard API is unavailable).

## Coordinate contract

Normalized display space everywhere between modules. Pixel conversion only at the edges:
`px = x * width`, `py = y * height` where width/height are the video-frame-sized overlay canvas.
Mirroring is applied exactly once (tracker output + renderer video UV flip). The present pass is the
only place that knows about the CSS canvas and the fit mode.

## Contract v1.2.0 (summary)

Additive over 1.1.0 (full entry in `contract-changes.md`): `FitMode`, `LookSettings`/`DEFAULT_LOOK`,
`QualitySettings.inferenceMaxHeight/faceStride`, `RenderInputs.fitMode/look`,
`Renderer.stats.gpuMs`/`warm()`; contract `TrackerInfo`, `TrackerOptions.inferenceMaxHeight/faceStride`,
`Tracker.getInfo()`; `InteractionSettings.cornerSpring/dwellMs/dwellTolerance`, the `dwell` event,
`debug.dwellProgress`, `Director.stepIndex`; `HudBox`, `HudCountdown`, `HudExtras`; capture
`SelfTimerSeconds`/`AutoStopSeconds`/`SnapshotFormat`/`DwellAction`, `CaptureSettings`,
`SnapshotOptions`, `RecorderOptions.maxDurationMs`, `Recorder.hasPendingResult`; `FileTransport`,
`TransportState`, `FrameSource.error/onStatus/transport`; store `CountdownState`, `CaptureRequest`,
settings `fitMode/thinStripGlitch/look/capture`, session
`trackerProgress/trackerError/windowOpen/contextLost/countdown/transport/captureRequest`;
`RuntimeDiagnostics`, `RuntimeHandle.retryTracker/requestRender/getDiagnostics`;
`PersonaLayer.update(..., look)`, `setReducedMotion`, `invalidate`. Settings persistence envelope
`SETTINGS_VERSION 2` (still memory-only).

## Dev-only hooks

The runtime exposes `window.__alterframe` (a `RuntimeHandle`) and `injectTracking(frame)` **only**
when `import.meta.env.DEV` or `import.meta.env.VITE_E2E === '1'`, and only if the page URL has
`?mockTracking=1`. Production builds strip both paths; `tests/e2e/production-gate.spec.ts`
verifies it against a served production build (`npm run serve:dist`).

## Static payload

```
dist/
  index.html                hashed entry (no inline scripts; CSP script-src 'self')
  assets/*.js|css|woff2     content-hashed → Cache-Control immutable; the tracking/MediaPipe code
                            is a separate chunk imported on tracker init (see bundle-report.mjs)
  models/*.task|tflite      fetched by `prebuild` (Apache-2.0, not in Git) → 1-day cache + SWR
  wasm/*.js|wasm            copied by `postinstall` from @mediapipe/tasks-vision → 1-day cache + SWR
  icons/*.svg, favicon.svg, manifest.webmanifest, robots.txt
```

Measured on the v0.2 build (Vite build output, decimal kB): entry `index-*.js` 387.4 kB raw /
125.1 kB gzip — react-dom ≈ 53 % of the entry, our own source ≈ 155 kB raw (app ≈ 43 kB, render/core
≈ 21, persona ≈ 18, runtime ≈ 12, hud ≈ 10, media ≈ 9, interaction ≈ 9, ui ≈ 8, capture ≈ 6, state ≈ 6,
perf ≈ 4); `tracking-*.js` 170.7 kB / 52.1 kB gzip with 0 MediaPipe markers in the entry; CSS 24.8 kB /
5.2 kB gzip; total JS 177.2 kB gzip. Budgets (`scripts/bundle-report.mjs`, same decimal unit; its own
gzip of the same files prints slightly smaller numbers — a different zlib level): total ≤ 450 kB gz,
entry ≤ 128 kB gz (measured + ≈ 2 % headroom), MediaPipe-free entry — all blocking in CI (`--strict`).
Splitting Settings/Help with `React.lazy` would save only ≈ 4 kB gz for a loading state nobody needs,
so the shell stays one chunk.

`scripts/serve-dist.mjs` serves this folder locally with the same headers, rewrites and clean URLs
that `vercel.json` declares, so the production gate runs against the real policy before a deploy.
