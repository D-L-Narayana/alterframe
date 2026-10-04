# Contract change requests

Append a dated entry: requester, file, proposed change, reason. Lead applies and bumps `CONTRACT_VERSION` in src/types/index.ts.

## 2026-10-04 — lead — v1.2.0 (v0.2 pre-dispatch, additive)
- `render.ts`: `FitMode` ('cover' | 'contain'), `LookSettings` + `DEFAULT_LOOK` (multipliers around the v0.1 constants; defaults reproduce the v0.1 render exactly), `PassContext.look`, `QualitySettings.inferenceMaxHeight` (720) and `faceStride` (1), `RenderInputs.fitMode` + optional `look`, `Renderer.stats.gpuMs`, optional `Renderer.warm(presets)`.
- `tracking.ts`: `TrackingDelegate`, contract `TrackerInfo` (+ `inferenceSize`), `TrackerOptions.inferenceMaxHeight/faceStride`, optional `Tracker.getInfo()`; `init()` documented re-entrant after failure.
- `interaction.ts`: `InteractionSettings.cornerSpring` (0 = off), `dwellMs`, `dwellTolerance`; `InteractionEvent` `'dwell'`; `debug.dwellProgress`; optional `Director.stepIndex`.
- `hud.ts`: `HudBox`, `HudCountdown`, `HudExtras` (countdown, dwellProgress); `HudCallout.id` gains `'mouth'`; `HudModel.boxes/countdown/dwellProgress`.
- `capture.ts`: `SelfTimerSeconds`, `AutoStopSeconds`, `SnapshotFormat`, `DwellAction`, `CaptureSettings` + `DEFAULT_CAPTURE_SETTINGS`, `SnapshotOptions`, `RecorderOptions.maxDurationMs`, `Recorder.snapshot(aspect, opts?)`, optional `Recorder.hasPendingResult`.
- `media.ts`: `FileTransport`, `TransportState`; `FrameSource` gains optional `error`, `onStatus`, `transport`.
- `store.ts`: `CountdownState`, `CaptureRequest`; `SettingsSlice` gains `fitMode`, `thinStripGlitch`, `look`, `capture`; `SessionSlice` gains `trackerProgress`, `trackerError`, `windowOpen`, `contextLost`, `countdown`, `transport`, `captureRequest`.
- `runtime.ts`: `RuntimeDiagnostics`; `RuntimeHandle` gains optional `retryTracker`, `requestRender`, `getDiagnostics`; `snapshot(aspect, opts?)`.
- `persona.ts`: `update(frame, scene, t, look?)`, optional `setReducedMotion`, `invalidate`.
- Settings persistence envelope bumped to `SETTINGS_VERSION 2` (`alterframe.settings.v2`); memory-only storage unchanged.
- Reason: v0.2 upgrade (loading/failure recovery, hands-free capture, file transport, letterbox fit, look tuning, diagnostics, cost-aware quality). Optional handle/tracker methods become required at integration once every module ships them.

## 2026-10-04 — lead — v0.2 integration (v1.2.0 kept; no type changes required)
- The optional members added in v1.2.0 (`RuntimeHandle.retryTracker/requestRender/getDiagnostics`, `Tracker.getInfo`, `Renderer.warm`, `PersonaLayer.setReducedMotion/invalidate`, `Recorder.hasPendingResult`) are implemented by every shipped module. They stay optional in the contract: the UI already reads them with optional chaining, and the unit-test doubles (`tests/unit/app/runtimeSession.test.ts`, `tests/unit/media/runtimeFeatures.test.ts` "tolerates renderers without warm()") rely on partial implementations. Flipping them would only add casts.
- `HudModel.boxes` is on the contract since v1.2.0 (the v1.1.0 `HudModelExt`-only note above is historical).
- Tracking: `createCanvas` (inference canvas factory) stays a module extension of `AlterFrameTrackerOptions`; the contract exposes the result through `TrackerInfo.inferenceSize`.
- Runtime: with the HUD callouts switched off a running self-timer is still drawn (numeral-only model built from a null frame/quad); the dwell ring stays HUD-gated because it anchors on the corner callout.
- Letterbox (`fitMode: 'contain'`) bars are part of recordings and snapshots by design (the stage canvas is what gets captured); the default `cover` output is unchanged.

## 2026-10-02 — lead — v1.1.0 (pre-dispatch)
- Added `src/types/runtime.ts`: `RuntimeDeps`, `RuntimeHandle` (incl. optional `injectTracking` for e2e mock mode), `CreateTracker` signature with `onProgress`, `DirtyCanvas`, `window.__alterframe`.
- Reason: makes W2 ↔ W1 wiring and W10 e2e mock tracking explicit (v1.1.0 addendum; historical, see `docs/handoffs/`).

## 2026-10-02 — W5 (shaders) — requests, no type changes needed
1. **W2 `src/runtime/index.ts` base layer preset.** Today `baseStyle: scene.base === 'comic' ? presets.comic : null`. `STYLE_PRESETS.comic` contains the `backdrop` pass, and W4 runs base and window chains with the same `u_backdrop` (persona backdrop), so with `base: 'comic'` the whole frame's background would be replaced by the night city / warm paper instead of showing the stylized room (reel phases 3 and 5 show the real room as comic). Proposed one-liner: import `COMIC_BASE_PRESET` (or `presetForLayer(scene, 'base')`) from `@/render/styles` and use it for `baseStyle`. `COMIC_BASE_PRESET` has `id: 'comic'`, `usesBackdrop: false`, same passes minus `backdrop`. Alternative for W4: bind the ingested video (or paper) as `u_backdrop` when running `baseStyle`.
2. **Docs only — `PassContext.width/height` semantics.** W4 calls `uniforms({ ...ctx, width: w, height: h })` with the PASS output size (after `pass.scale`). W5 passes rely on this (`pxScale(ctx, passScale)`), so please keep it; suggest adding that sentence to the `PassContext` comment in `src/types/render.ts`.
3. **Confirmed, no change:** W4 binds a 1×1 white mask when segmentation is absent and a paper-white backdrop when `personaBackdrop` is null — W5 passes degrade gracefully in both cases (verified in `src/render/shaders/__harness__/verify.mjs`).

## 2026-10-02 — lead — integration merge (v1.1.0 kept; no type changes required)
Merged from `docs/handoffs/W1..W10.md`. Decisions:
- **W1** `@fontsource/inter` installed by W10 and imported in `src/main.tsx` (300/400/600). `trackerProgress01`/`captureAspect` store fields: not added (UI uses the runtime handle / `useUiStore`).
- **W2** `AlterFrameRuntime` extension fields stay module-level exports (`@/runtime`), not lifted into `src/types`. Runtime factories switched from `import.meta.glob` + stubs to **static imports** (`src/runtime/factories.ts`); `stubs.ts` is test-only. Thin-strip glitch stays off (no `thinStripGlitch` setting exposed in v1.1.0; the "static" seen through a thin slit is the illustration sampled through the slit, not a glitch).
- **W3** `Tracker.getInfo()` stays a module extension. **One-Euro defaults changed to `beta 1.5`** (was 0.02) to meet criterion A1 (≤ 2 frames lag); `tests/unit/tracking/latency.test.ts` pins it. Photoreal harness fixture removed from the tree (private, outside repo); harness takes any local image.
- **W4** `RendererDebug` hook: not added to the contract.
- **W5** `PassContext.width/height` = pass output size (documented here; W4 behaviour kept). Base layer uses `presetForLayer(scene,'base')` (W2 already does).
- **W6** torso shoulder width stays 1.6× face width (the user's own clothing stays visible beside the suit; a deliberate design decision).
- **W7** `Director.stepIndex` / `drawLandmarks` extras stay module extensions.
- **W8** mouth box carried in `HudModelExt.boxes` (superset of `HudModel`); contract left unchanged at the time (v1.2.0 later moved `boxes` onto `HudModel`).
- **W10** dev deps added (`typescript-eslint`, `@eslint/js`, `eslint-plugin-react-hooks`, `globals`, `@types/node`), `engines.node` tightened to Vite 8's range, `/models` and `/wasm` cache policy `max-age=86400, stale-while-revalidate` (not immutable — stable file names, changing contents).
