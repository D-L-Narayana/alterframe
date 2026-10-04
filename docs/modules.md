# Module guide

One section per `src/` folder: what it does, its public API (the entry `index.ts` or the files
named), and the coordinate conventions it relies on. Shared types live in `src/types/**` and are the
only cross-module contract (`CONTRACT_VERSION` 1.2.0); every module imports from `@/types`, never
from another module's internals, and dev harness folders (`__harness__`) are never imported by app
code. Browser-only concerns (DOM, WebGL2, MediaStream) are kept behind injectable factories so the
pure parts run in Node unit tests.

Coordinate vocabulary used below:

* **Display space** — normalized `[0,1]²`, origin top-left, x right, y down, **after mirroring**
  (screen-left ≈ 0). Everything exchanged between modules is in display space of the **intrinsic
  video frame** (`videoWidth × videoHeight`).
* **Video pixels** — the intrinsic frame in device pixels (`px = x · videoWidth`). Overlay canvases
  (persona, HUD) have exactly this size.
* **Canvas** — the CSS box × dpr the renderer presents into; only the present pass maps display
  space to it (`cover` crop or `contain` letterbox), and only the renderer knows the CSS size.
* Mirroring happens exactly once per stream: the tracker mirrors landmarks and mask columns; the
  renderer flips the video UV. Nobody else mirrors. Canvas2D uses straight (non-premultiplied) alpha.

---

## `src/types` — contracts

Pure types and constants: `geometry` (`Vec2/3`, `Rect`, `Size`, `QuadCorners` TL,TR,BR,BL),
`tracking` (`TrackingFrame`, `HandTrack`, `FaceTrack`, `SegmentationResult`, `TrackerInfo`,
`TrackerOptions`, `Tracker`, `HAND_LM`/`FACE_LM` landmark indices), `scene` (`SceneState`,
`PERSONA_ORDER`, `REFERENCE_SEQUENCE`), `interaction` (`WindowQuad`, `InteractionSettings` +
defaults, `InteractionEvent` incl. `dwell`, `Director`), `render` (`StylePass`, `StylePreset`,
`FitMode`, `LookSettings`/`DEFAULT_LOOK`, `QualitySettings`/`DEFAULT_QUALITY`, `RenderInputs`,
`Renderer`), `persona` (`PersonaLayer`, `PERSONA_TOKENS`), `hud` (`HudCallout`, `HudBox`,
`HudCountdown`, `HudExtras`, `HudModel`, `Hud`), `media` (`FrameSource`, `FileTransport`,
`TransportState`, `SourceStatus`), `capture` (`CaptureSettings`, `Recorder`, `SnapshotOptions`,
`PerfSample`, `AdaptiveQualityPolicy`), `store` (`SettingsSlice`, `SceneSlice`, `SessionSlice`,
`CountdownState`, `CaptureRequest`), `runtime` (`RuntimeDeps`, `RuntimeHandle`,
`RuntimeDiagnostics`, `CreateTracker`, `DirtyCanvas`, `window.__alterframe` declaration).
Changes go through `docs/contract-changes.md`.

## `src/app` — application shell and workflows

Purpose: routing on `sourceStatus` (onboarding → stage → error panel), the controls bar, Settings
sheet (groups Window & gestures, Quality, Look, HUD, Display, Capture, Diagnostics), Help dialog,
status toast, tracker loading bar and failure card, coach hint, countdown banner, file transport,
and the user-facing workflows.

Public API (`src/app/index.ts`): `App`; `useRuntime(canvasRef, handleRef, spec, attempt, sourceRef?)`
→ `{ switchSource, getTransport }` with the pure `bootSession`, `teardownSession`,
`preserveRecording`; `useActions(handleRef, sourceRef)` → `AppActions` (persona/base/HUD, record,
timed record, snapshot, cancel countdown, retry/continue tracking, transport keys, Esc priority);
`createCaptureController(deps)` (self-timer / auto-stop / hold-still state machine, fake-timer
testable); `createTransportActions(deps)` (`P [ ] L`); `installContextLostToasts(store, notify)`;
`formatDiagnostics`, `copyToClipboard`, `DIAGNOSTIC_ROWS`; shortcuts (`resolveShortcut`,
`resolveEscape`, `dispatchShortcut`, `installShortcuts`, `SHORTCUT_MAP`); `format.ts`
(`formatElapsed`, `formatSeconds`, `extensionForMime`, `captureFilename`, `mapSourceError`,
`downloadBlob`); `SourceSpec`.

Conventions: the UI never reads `window.__alterframe` — the `RuntimeHandle` lives in a React ref;
the store is the single source of truth for everything the runtime renders (countdown, look,
fitMode, capture, transport); `countdown.endsAt` is in the `performance.now()` domain; seek values
are seconds. Accessible names are the e2e selector contract (`docs/testing.md`).

## `src/ui` — primitives

`Button`, `IconButton` (aria-label + optional `aria-pressed`), `Toggle` (`role="switch"`),
`Segmented` (radiogroup with roving tabindex; Arrow/Home/End), `Slider` (`<input type=range>` with
`aria-valuetext`), `Dialog`/`Sheet` (`role="dialog"`, `aria-modal`, focus trap via `useFocusTrap`,
Esc, focus restore), `Kbd`, icons. Styles in `ui.css`; design tokens in `src/styles/tokens.css`.

## `src/state` — store

`createAppStore({ storage? })` / `useAppStore` implementing `AppState` exactly: settings (persisted
through a pluggable `SettingsStorage`; default **memory-only**, envelope `alterframe.settings.v2`,
every field clamped/validated on read), scene (`setScene` derives `hudTint` when `hudTintAuto`,
`cyclePersona`, `setDirectorRunning`), session (`setSession`). `persistence.ts`: `defaultSettings`,
`serializeSettings`, `deserializeSettings`, `SETTINGS_VERSION`. `uiStore.ts`: panel, toast, facing
mode, per-session dismissals, armed auto-stop. `hooks.ts`: `useScene`, `useSettings`, `useSession`
(shallow selectors). No browser storage anywhere (hygiene-tested).

## `src/media` — frame sources

`createCameraSource(opts)` (getUserMedia with exact-then-relaxed constraints, device list, precise
failure statuses) and `createFileSource(file | url)` (object URL, loop by default, `transport`
play/pause/seek/setLoop + `onTransport` events, ends paused when loop is off). Both are
`ObservableFrameSource`s (`onStatus`, `error`) built on `createFrameClock` (requestVideoFrameCallback
with a rAF fallback that also emits on `currentTime` change while paused). `MediaSourceError`,
`classifyGetUserMediaError`, `describeMediaError`, `hasTransportEvents`, `isFileSource`,
`isCameraSource`, `resolveMediaEnv` (injectable DOM for Node tests). Sizes reported are intrinsic
video pixels.

## `src/runtime` — the loop

`startRuntime({ canvas, store, source }, options?)` → `AlterFrameRuntime` (`RuntimeHandle` plus
`ready`, `trackerReady`, `trackerProgress`, `onTrackerProgress`, `source`, `frameCount`,
`windowOpen`, `lastTracking`, `lastError`). Per frame: tracker options sync (mirrored, strides,
inference height — forwarded only on change), tracking (or an injected frame in dev/e2e),
interaction → events (`window-open/close` → `session.windowOpen`, `cycle-persona`, `dwell` →
`session.captureRequest`), director, persona (`look`, reduced motion), HUD (countdown, dwell
progress), renderer (`fitMode`, `look`, glitch), perf + adaptive quality, session sync (fps,
recorder state, tracker progress ≤ 10 Hz, transport). Also: `retryTracker()`, `requestRender()`
(paused sources re-render on store changes, debounced to one animation frame), `getDiagnostics()`,
context-lost mirroring, idle-time shader warm-up (`WARM_PRESETS`). `createLazyTracker` imports
`@/tracking` dynamically on `init()`; `hudCountdown(countdown, now)` maps the store countdown to the
HUD model; `computeGlitch`; `viewport.ts` (`computeCoverFit`, `videoToDisplay`, `displayToVideo`,
`overlaySizeFor`) is the reference cover-fit definition; `registry.ts` (`getActiveRuntime`,
`subscribeRuntime`) is the production-safe way to reach the live runtime; `devBridge.ts` gates
`window.__alterframe` / `injectTracking` behind `import.meta.env.DEV || VITE_E2E === '1'`.

## `src/tracking` — MediaPipe wrapper (lazy chunk)

`createTracker(opts, onProgress)` → `AlterFrameTracker` (`init` re-entrant after failure, `update`,
`setOptions`, `ready`, `getInfo`, `dispose`). Models are streamed by `loader.ts` with byte-level
progress (`ModelCache`, `ProgressAggregator`, `MODEL_SPECS`); wasm and models load from the same
origin (`/wasm`, `/models`, resolved relative to the page base). `inference.ts`: `inferenceTarget`,
`evenSize`, `createDefaultInferenceCanvas` (downscale frames taller than `inferenceMaxHeight` once
per analysed frame; `OffscreenCanvas` → `<canvas>` fallback). `derive.ts`: `deriveHand`,
`deriveFace`, `matchHands`, `sortHands`, `assignSides`, `mirrorLandmarks`. `mask.ts`: `MASK_SIZE`
(256), `resampleMask`, `maskOrientationFlipY`. `smoothing.ts`: `OneEuroFilter`,
`LandmarkSetSmoother`, `DEFAULT_SMOOTHING`. `telemetryGuard.ts`: an idempotent guard on the global
`fetch` that rejects MediaPipe's built-in usage-log request (`odml.pa.googleapis.com`) locally and
records the attempt in `TrackerInfo.warnings` — see `security.md`. Output convention: display space
of the intrinsic frame, mirrored exactly once here; the mask is row-major, top-left origin, already
mirrored; `side` is screen position, not handedness; hands sorted by `palmCenter.x`.

## `src/render/core` — WebGL2 compositor

`createRenderer(options?)` → `CoreRenderer` (`Renderer` plus `contextLost`, `contextLossCount`,
`getDebug()`, `gl`). Context: `premultipliedAlpha: false`, `preserveDrawingBuffer: true`. The
compositor runs base and window pass chains at the internal resolution (`internalSize`), draws the
quad mask as two triangles, mixes, composites the HUD and presents with **one** fit mapping:
`fit.ts` — `coverFit`, `containFit`, `fitFor(mode)`, `fitContentRect`, `displayToCanvasPx`,
`canvasPxToDisplay`, `quadToClipTriangles`, `displayToClip`, `backingSize`, `TEXTURE_UNITS`.
`warm.ts` (`WarmQueue`, `pickIdleScheduler`) compiles preset programs in idle chunks;
`gpuTimer.ts` (`GpuTimer`) reads `EXT_disjoint_timer_query_webgl2` asynchronously. GL helpers:
`compilePass`, `createProgram`, `createTexture`, `createFbo`, `fullscreenTriangle`, `PassRunner`,
`ProgramCache`, `TargetPool`, `UniformCache`, `chooseMaskFormat`, the fragment prelude
(`FRAG_PRELUDE`, `buildFragmentSource`). GL orientation: intermediate textures keep row 0 = display
top; the single y flip happens in the present pass; `contain` bars are painted opaque black and
overlays/HUD are sampled through the same mapping.

## `src/render/shaders` + `src/render/styles.ts` — stylization passes and presets

GLSL ES 3.00 fragment bodies (`smoothH/V`, `quantizeClean/Warm`, `inkPaper/Comic`, `halftone`,
`backdrop`, `gradePaper/Comic`; `ALL_PASSES`) with `uniforms(ctx)` driven by `ctx.look`
(`lookFactor`, `inkWidthTexels`, `pxScale`): ink width × `look.inkWidth`, Sobel thresholds ×
`look.inkThreshold`, bands = `look.bands`, saturation 1.25 × `look.saturation`, halftone darken
0.25 × `look.halftone`, grain 0.03 × `look.grain`. `DEFAULT_LOOK` reproduces the 0.1 constants
(golden-tested). `styles.ts`: `STYLE_PRESETS` (`paper-portrait`, `comic`), `COMIC_BASE_PRESET`
(comic without the backdrop pass, for the base layer), `ALL_PRESETS` (warm-up list),
`presetForLayer(scene, 'base' | 'window')`. Passes are orientation-agnostic; `PassContext.width/
height` are the pass output size.

## `src/render/persona` — overlays and backdrops

`createPersonaLayer({ createCanvas?, reducedMotion?, seed? })` → `PersonaLayerHandle`
(`resize(videoSize)`, `update(frame, scene, t, look?)`, `overlay`, `backdrop`, `personaId`,
`setReducedMotion`, `invalidate`). Procedural, original vector art: portrait (paper + lip/eye
accents), masked (opaque white mask, pink lens outlines that squint with eye openness), suit (web
pattern + original spider emblem); backdrops paper / night city (head parallax `HEAD_PARALLAX`,
frozen under reduced motion) / warm paper. Canvases are repainted only when their signature
(`overlaySignature`, `backdropSignature`) changes and flag `__dirty` for the compositor.
`overlayStrengthOf(look)` scales overlay alpha (cap `OVERLAY_MAX_ALPHA`). Canvases are sized to the
video frame in device pixels; geometry helpers work in display space.

## `src/interaction` — window geometry, gestures, director

`createInteraction(options?)` → `Interaction` (`update(frame, t, scene, settings)` →
`{ quad, events, debug }`, `reset`). `windowQuad.ts`: `selectHands`, `computeWindowQuad`,
`orderConvex`, `orderFaithful`, `isSelfIntersecting`, `shoelaceArea`. Hold `holdMs` / fade `fadeMs`
after a hand is lost; `window-open/close` on the visibility edge. `gesture.ts`: hands-together ≥
`togetherArmMs` then open → one `cycle-persona` (debounced `CYCLE_DEBOUNCE_MS`). `spring.ts`:
optional critically damped corner spring (`settings.cornerSpring`, 0 = off). `dwell.ts`:
`createDwellDetector` — `dwell` once per stillness episode when no corner moved more than
`dwellTolerance` over `dwellMs`; `progress` 0..1. `director.ts`: `createDirector(sequence?)`,
`stepIndexAt`, `sceneForStep`. `debugDraw.ts`: `drawLandmarks`. All coordinates display space; quad
corners TL,TR,BR,BL (screen-left hand supplies TL/BL).

## `src/hud` — callouts overlay

`createHud(opts?)` → `HudHandle` (`resize`, `buildModel(frame, quad, scene, t, extras)` pure,
`draw(model)` only when the model key changed, `setOptions`). Draws 7-digit tracking-style codes
with leader lines at the window corner and eyes, an open-mouth box, the recording dot, the fps
badge, the self-timer numeral (`COUNTDOWN_LABELS`, 18 % of canvas height, no pulse under reduced
motion) and the dwell ring at the corner callout. Exports `buildHudModel`, `drawHud`, `codePrefix`,
`buildCode`, `drawDebugLandmarks`, layout constants (`hudLayout`), `HUD_FONT_WARMUP`. White on the
live base, red on comic (`scene.hudTint`). Canvas sized to the video frame.

## `src/capture` — recorder and snapshots

`createRecorder(getCanvas, deps?)` → `Recorder` (`start({ aspect, videoBitsPerSecond?,
mimeCandidates?, fps?, maxDurationMs? })`, `stop()`, `snapshot(aspect, { format?, quality? })`,
`state`, `elapsedMs`, `hasPendingResult`). Centre-crop plans with even dimensions
(`computeCrop`, `OUTPUT_SIZES`: 16:9 → 1920×1080, 9:16 → 1080×1920, 1:1 → 1080×1080, `source`
keeps the canvas size); `DEFAULT_MIME_CANDIDATES` / `pickMime` (MP4 where supported, else WebM);
`DEFAULT_MAX_DURATION_MS` 600 000 with the self-finalised result held for the next `stop()`;
`snapshot` PNG default, JPEG/WebP via `toBlob`/`convertToBlob` with a PNG fallback;
`captureFilename`, `extensionForMime` (`alterframe-YYYYMMDD-HHMMSS.{png|jpg|webp|webm|mp4}`),
`download`. Works on canvas pixels; the composited canvas includes the HUD.

## `src/perf` — frame-rate monitor and adaptive quality

`createPerfMonitor({ emaTauMs?, bufferMs? })` (`sample`, `fps`, `recent(ms)`; EMA re-seeded after
pauses). `createAdaptivePolicy(options)` → `AdaptiveQualityPolicy.evaluate(samples, current)`:
median fps below `lowFps` (22) over 2 s → `stepDown`; every sample above `highFps` (40) over 5 s →
`stepUp`; 3 s cooldown. `qualityLadder(options)` is the rung order (`inferenceMaxHeight`,
`segmentationStride`, `faceStride`, `renderScale`, floors `minInferenceHeight` 360, `maxFaceStride`
3, `minScale` 0.5); the cost-aware branch takes `stepDownRenderScale` when the median render time
exceeds the median tracking time; `stepUp` restores in exact reverse order. `median` exported.

## `src/styles` — global CSS and tokens

`global.css` (reset, focus rings, reduced-motion tokens driven by `data-reduced-motion`) and
`tokens.css` (dark palette, spacing, radii, type scale). No inline styles are needed by the app.

---

## Dev harnesses and scripts

Each module may keep a `__harness__/` page (served by the Vite dev server only, excluded from lint,
never bundled) for visual sandboxing. Repository scripts (`scripts/*.mjs`, Node built-ins only):
`fetch-models.mjs`, `copy-wasm.mjs`, `verify-dist.mjs` (postbuild gate), `bundle-report.mjs`
(per-chunk sizes, budgets, entry-chunk MediaPipe check, `--strict`), `serve-dist.mjs` (production-
like static server applying `vercel.json`), `with-server.mjs` (run a command against it),
`hygiene.mjs` (release hygiene scan, `--git`). Test fixtures: `tests/fixtures/make-fixture.mjs`
generates the synthetic fake-camera clips and the schedule JSON.
