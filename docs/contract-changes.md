# Contract change requests

Append a dated entry: requester, file, proposed change, reason. Lead applies and bumps `CONTRACT_VERSION` in src/types/index.ts.

## 2026-10-02 — lead — v1.1.0 (pre-dispatch)
- Added `src/types/runtime.ts`: `RuntimeDeps`, `RuntimeHandle` (incl. optional `injectTracking` for e2e mock mode), `CreateTracker` signature with `onProgress`, `DirtyCanvas`, `window.__alterframe`.
- Reason: makes W2 ↔ W1 wiring and W10 e2e mock tracking explicit; see ten-worker-contracts.md addendum.

## 2026-10-02 — W5 (shaders) — requests, no type changes needed
1. **W2 `src/runtime/index.ts` base layer preset.** Today `baseStyle: scene.base === 'comic' ? presets.comic : null`. `STYLE_PRESETS.comic` contains the `backdrop` pass, and W4 runs base and window chains with the same `u_backdrop` (persona backdrop), so with `base: 'comic'` the whole frame's background would be replaced by the night city / warm paper instead of showing the stylized room (reel phases 3 and 5 show the real room as comic). Proposed one-liner: import `COMIC_BASE_PRESET` (or `presetForLayer(scene, 'base')`) from `@/render/styles` and use it for `baseStyle`. `COMIC_BASE_PRESET` has `id: 'comic'`, `usesBackdrop: false`, same passes minus `backdrop`. Alternative for W4: bind the ingested video (or paper) as `u_backdrop` when running `baseStyle`.
2. **Docs only — `PassContext.width/height` semantics.** W4 calls `uniforms({ ...ctx, width: w, height: h })` with the PASS output size (after `pass.scale`). W5 passes rely on this (`pxScale(ctx, passScale)`), so please keep it; suggest adding that sentence to the `PassContext` comment in `src/types/render.ts`.
3. **Confirmed, no change:** W4 binds a 1×1 white mask when segmentation is absent and a paper-white backdrop when `personaBackdrop` is null — W5 passes degrade gracefully in both cases (verified in `src/render/shaders/__harness__/verify.mjs`).

## 2026-10-02 — lead — integration merge (v1.1.0 kept; no type changes required)
Merged from `docs/handoffs/W1..W10.md`. Decisions:
- **W1** `@fontsource/inter` installed by W10 and imported in `src/main.tsx` (300/400/600). `trackerProgress01`/`captureAspect` store fields: not added (UI uses the runtime handle / `useUiStore`).
- **W2** `AlterFrameRuntime` extension fields stay module-level exports (`@/runtime`), not lifted into `src/types`. Runtime factories switched from `import.meta.glob` + stubs to **static imports** (`src/runtime/factories.ts`); `stubs.ts` is test-only. Thin-strip glitch stays off (no `thinStripGlitch` setting exposed; errata §4b.1).
- **W3** `Tracker.getInfo()` stays a module extension. **One-Euro defaults changed to `beta 1.5`** (was 0.02) to meet criterion A1 (≤ 2 frames lag); `tests/unit/tracking/latency.test.ts` pins it. Photoreal harness fixture removed from the tree (private, outside repo); harness takes any local image.
- **W4** `RendererDebug` hook: not added to the contract.
- **W5** `PassContext.width/height` = pass output size (documented here; W4 behaviour kept). Base layer uses `presetForLayer(scene,'base')` (W2 already does).
- **W6** torso shoulder width stays 1.6× face width (user's own clothing visible beside the suit, consistent with errata §4b.7).
- **W7** `Director.stepIndex` / `drawLandmarks` extras stay module extensions.
- **W8** mouth box carried in `HudModelExt.boxes` (superset of `HudModel`); contract left unchanged.
- **W10** dev deps added (`typescript-eslint`, `@eslint/js`, `eslint-plugin-react-hooks`, `globals`, `@types/node`), `engines.node` tightened to Vite 8's range, `/models` and `/wasm` cache policy `max-age=86400, stale-while-revalidate` (not immutable — stable file names, changing contents).
