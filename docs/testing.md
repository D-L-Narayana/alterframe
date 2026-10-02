# Testing

Three layers, each with a clear claim. We are explicit about what a green run does **not** prove.

| Layer | Runner | Lives in | Proves |
|---|---|---|---|
| Unit | Vitest (node env) | `tests/unit/<module>/` per worker; `tests/unit/*.test.ts` + `tests/unit/infra/` (W10) | pure logic: geometry, state machines, shader source sanity, schedule/fixture generator, repo hygiene, config consistency |
| GPU harness e2e | Playwright + Vite dev pages | `tests/e2e/pages/*.html`, `shaders.spec.ts`, `render-pixels.spec.ts` | real WebGL2 (SwiftShader in CI): every style pass compiles and links; compositor puts window colour inside the quad / base outside / blends at opacity 0.5; a single cover-fit mapping at 3 viewports; mirroring applied once |
| App e2e | Playwright, Chromium fake camera + mock tracking | `tests/e2e/*.spec.ts` | the integrated app: onboarding → stage, no console errors, no third-party requests, window appears/disappears, persona cycles once, Director, recorder download > 0 bytes, PNG snapshot, axe 0 serious/critical, keyboard reachability, focus trap, camera denied/unavailable UI, visual baselines |

## What mock tracking does and does not prove

Chromium is started with `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=tests/fixtures/hands.y4m`.
The clip is **generated** (`npm run fixture`): grey background, ellipse head, torso, two L-shaped
hands moving on a schedule (together 0–2 s, apart skewed 2–8 s, together 8–10 s, apart wide 10–12 s).
MediaPipe is not expected to detect these cartoon shapes, so the suite injects synthetic
`TrackingFrame`s built from `tests/fixtures/hands.schedule.json` through the dev-only
`window.__alterframe.injectTracking` hook (`tests/e2e/helpers/mockTracking.ts`).

Therefore a green e2e run proves **wiring and rendering**: tracking → quad → compositor → HUD →
recorder with contract-shaped data. It does **not** prove tracking quality, latency or fps with a
real camera. Real-camera verification is a manual step on the preview URL (the sandbox has none).

## Commands

```bash
npm test                                   # all unit suites
npm run test:hygiene                       # repo hygiene + infra checks only
npm run fixture                            # regenerate hands.y4m + hands.schedule.json
npm run test:e2e                           # pretest:e2e regenerates the fixture if missing
npx playwright test tests/e2e/shaders.spec.ts tests/e2e/render-pixels.spec.ts   # GPU harness only
npm run test:a11y
npm run test:visual:update                 # (re)create visual baselines; commit tests/e2e/__screenshots__
E2E_BASE_URL=http://127.0.0.1:6220 npx playwright test   # reuse a running dev/QA server
E2E_PROD_URL=http://127.0.0.1:4173 npx playwright test tests/e2e/production-gate.spec.ts
```

The e2e `webServer` is the **Vite dev server** (`npm run dev -- --port 6220`), because the test
hooks exist only in dev / `VITE_E2E=1` builds. Set `E2E_BASE_URL` to reuse a server you started.

## Selector contract (e2e ↔ W1)

`tests/e2e/helpers/app.ts` selects by accessible names from the W1 contract:
"Use camera", "Open a video file", the privacy sentence, `<canvas id="stage">` with `aria-label`,
`radiogroup` named "persona" with `radio` options, buttons named Record / Snapshot / Settings /
Help / Director (with `aria-pressed` for toggles), dialogs with `role="dialog"`, `aria-live="polite"`
status. If names differ, change only `SEL` in that helper.

## Visual baselines

`tests/e2e/visual.spec.ts` screenshots persona × base with the skewed mock pose and
`prefers-reduced-motion: reduce` (deterministic HUD/backdrop). Baselines are created with
`npm run test:visual:update` and committed under `tests/e2e/__screenshots__/`; in CI the spec is
skipped until they exist. `maxDiffPixelRatio: 0.02`.

## Repo hygiene (`tests/unit/repo-hygiene.test.ts`, `scripts/hygiene.mjs`)

Scope: the tracked / deployable payload — everything under the app root **except** `node_modules`,
`dist`, `coverage`, `playwright-report`, `test-results`, `.vercel`, `public/wasm`, model binaries,
`tests/fixtures/*.y4m` and the lockfile. Rules: no file > 5 MB, no audio/video files, no `.env*`,
no forbidden strings (reel host, franchise/trademark names, creator handle, reference-material
paths), no raster images other than our own baselines, and source policy: no browser storage, no
eval/innerHTML sinks, dev hooks gated behind `import.meta.env.DEV`/`VITE_E2E`, harness folders
not imported by app code, models/wasm from our origin. This is a hygiene gate, not a security
audit — see `docs/security.md` for what was and was not reviewed.

## Known gaps (as of W10 handoff)

* Visual baselines are not committed yet (`npm run test:visual:update` on the final tree).
* `a11y.spec.ts` settings case: axe `color-contrast` on a muted slider hint (W1 token) — see `docs/handoffs/W10.md`.
* `repo-hygiene` flags a photoreal harness fixture image under `src/tracking/__harness__/fixtures/` (W3) — decision pending.
* Lighthouse and bundle budget are run manually by the lead (`scripts/bundle-report.mjs` prints
  gzip sizes against the 450 kB JS budget).
