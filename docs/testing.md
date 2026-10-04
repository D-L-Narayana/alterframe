# Testing

Three layers, each with a clear claim. We are explicit about what a green run does **not** prove.

| Layer | Runner | Lives in | Proves |
|---|---|---|---|
| Unit | Vitest (node env) | `tests/unit/<module>/` per module; `tests/unit/*.test.ts` + `tests/unit/infra/` | pure logic: geometry, state machines, capture controller (fake timers), lazy tracker, transport, dwell detector, shader uniform goldens, persona identity at defaults, schedule/fixture generator, repo hygiene, config/CI consistency, the serve-dist and bundle-report helpers |
| GPU | Vitest + Playwright Chromium (`tests/unit/render-core/gpu.test.ts`), Playwright harness pages (`shaders.spec.ts`, `render-pixels.spec.ts`) | `tests/unit/render-core`, `tests/e2e/pages/*.html` | real WebGL2 (SwiftShader in CI): every style pass compiles and links; the compositor puts window colour inside the quad / base outside / blends at opacity 0.5; one cover-fit mapping at 3 viewports; contain mode bars; warm-up compiles without GL errors; `gpuMs` is a number or null; context-loss recovery |
| App e2e | Playwright, Chromium fake camera + mock tracking | `tests/e2e/*.spec.ts` | the integrated app: onboarding → stage, no console errors, no third-party requests, window appears/disappears, persona cycles once, Director, recorder/snapshot downloads, self-timer/auto-stop, hold-still capture, file transport, display fit pixels, look pixels, diagnostics JSON, loading/retry, axe 0 serious/critical on every screen, keyboard reachability, focus trap, camera denied/unavailable UI, visual baselines, production gate |

## What mock tracking does and does not prove

Chromium is started with `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=tests/fixtures/hands.y4m`.
The clip is **generated** (`npm run fixture`): grey background, ellipse head, torso, two L-shaped
hands moving on a schedule (together 0–2 s, apart skewed 2–8 s, together 8–10 s, apart wide 10–12 s).
MediaPipe is not expected to detect these cartoon shapes, so most specs inject synthetic
`TrackingFrame`s built from `tests/fixtures/hands.schedule.json` through the dev-only
`window.__alterframe.injectTracking` hook (`tests/e2e/helpers/mockTracking.ts`). `loading.spec.ts`
and the production gate run the **real** tracker (wasm + models) to exercise loading and CSP.

Therefore a green e2e run proves **wiring and rendering**: tracking → quad → compositor → HUD →
recorder with contract-shaped data. It does **not** prove tracking quality, latency or fps with a
real camera. Real-camera verification is a manual step on the deployed URL (the sandbox has none).
Every timing in reports from this environment is labelled "SwiftShader / sandbox".

## Specs

| Spec | Scenario | Notes |
|---|---|---|
| `smoke` | onboarding, stage renders non-black frames, no third-party requests; fps badge contract: absent by default, `F` shows `N fps` with a matching `aria-label`, the runtime's frame counter advances while it is shown, the badge equals the rounded live `getStats().fps` within one 250 ms sync period (read in one browser-side step), `F` hides it again | the runtime→store cadence (`fps: Math.round(stats.fps)` every 250 ms) and the `FpsBadge` rendering are covered deterministically by `tests/unit/media/runtime*.test.ts` and `tests/unit/app/components.test.tsx`. A "text changes within N seconds" check is not a product contract: a steady frame rate legitimately never changes the text, and the window measures scheduler latency rather than anything the app promises. The liveness baseline (`frameCount`) is taken right after the camera starts so the check spans the whole test instead of a tail poll, and the test is classified `slow` because the real tracker's synchronous MediaPipe wasm init on SwiftShader takes 10–30 s inside it — a budget class, not a changed assertion. |
| `window` | quad appears/disappears, mirroring once, gesture cycle exactly once, short hold does not cycle | environmental skip when frame pacing is too slow to hold a short pose |
| `director`, `recorder`, `camera-denied`, `visual` | as in 0.1 | visual baselines regenerated only by the lead |
| `loading` | progressbar → 100 → gone; `/models/*` blocked → failure card → Retry tracking → loads; Continue without tracking | real tracker; long timeouts |
| `capture-timer` | Self-timer 3 s + Auto-stop 10 s → "Recording starts in N" → recording ≥ 2.5 s later → download without pressing R; `T`; Esc cancels (no download); `S` with a timer | |
| `transport` | 2 s WebM generated in-page (`makeWebmFixture`), opened via the hidden file input → Playback nav → Pause/Play, `P`; non-vacuous seek precondition: the paused clip is parked at the END through the keyboard path (`]`, which seeks directly) before the slider's `Home` must bring it to 0; then `]`×2 returns the store to exactly that end position and the no-revival assertion checks the slider still shows the end (a spent seek intent must not re-activate); `[`, `S` while paused → PNG; Loop switch + `L`; clip ends paused with loop off | skips with a reason when the browser cannot record a canvas stream |
| `fit` | 390×844: Display fit → Fit → top/bottom bars black, centre not; Fill → not black; default is Fill | geometry from `fitRect`/`containBars` |
| `look` | Ink thickness at max (keyboard End) → dark-pixel fraction inside the window rises; Reset look restores; slider ranges/defaults | |
| `dwell` | Hold still → Snapshot: still wide pose → PNG within ~4 s, exactly once; Off never captures | |
| `diagnostics` | rows present, Tracking non-empty, Frame refreshes; Copy diagnostics → clipboard JSON with `fps`, `quality` | `test.use({ permissions: ['camera', 'clipboard-read', 'clipboard-write'] })` in this spec only |
| `a11y` | axe on onboarding, stage, settings (all groups), help, failure card, transport; tab order; focus trap | |
| `headers` | parses `vercel.json` (declared policy) | |
| `production-gate` | against a served production build: no dev hooks with `?mockTracking=1`; no inline scripts; **0 CSP violations** across onboarding → camera → settings → 1 s recording with the real tracking runtime; live headers equal `vercel.json` (`/`, entry asset, model, wasm) | runs only with `E2E_PROD_URL` |

### How skips work

Only **environmental** skips exist, each visible in the report with its reason: a measured
precondition of the machine, never a product threshold. `window.spec.ts` skips the "short together"
case when software rendering cannot release a pose under 500 ms (the measured hold is in the
message); `transport.spec.ts` and the transport a11y case skip when MediaRecorder cannot record a
canvas stream to WebM (fixture impossible); `production-gate.spec.ts` skips entirely when
`E2E_PROD_URL` is unset; `visual.spec.ts` skips in CI when no baselines are committed. A spec must
never skip because a control is missing — a missing control is a failure.

## Commands

```bash
npm test                                   # all unit suites (the GPU suite skips without Chromium)
npm run test:hygiene                       # repo hygiene + infra checks only
npx vitest run tests/unit/render-core/gpu.test.ts --hookTimeout 300000 --testTimeout 120000
                                           # GPU pixel tests: the harness boots a Vite server + Chromium,
                                           # which needs the long hook timeout on slow machines (CI uses these flags)
npm run fixture                            # regenerate hands.y4m, hands-still.y4m + hands.schedule.json
npm run test:e2e                           # pretest:e2e regenerates the fixture if missing
npx playwright test tests/e2e/fit.spec.ts  # one spec (recommended on small machines: one browser at a time)
npx playwright test tests/e2e/shaders.spec.ts tests/e2e/render-pixels.spec.ts   # GPU harness only
npm run test:a11y
npm run test:visual:update                 # (re)create visual baselines; commit tests/e2e/__screenshots__
E2E_BASE_URL=http://127.0.0.1:6220 npx playwright test   # reuse a running dev/QA server
npm run build && node scripts/with-server.mjs -- npm run test:prod-gate   # production gate via serve-dist
E2E_PROD_URL=https://<host> npx playwright test tests/e2e/production-gate.spec.ts   # against a deployment
```

The e2e `webServer` is the **Vite dev server** (`npm run dev -- --port 6220`), because the test
hooks exist only in dev / `VITE_E2E=1` builds. Set `E2E_BASE_URL` to reuse a server you started;
`scripts/with-server.mjs` exports both `E2E_PROD_URL` and `E2E_BASE_URL` so the production gate
never boots the dev server.

### The serve-dist gate

`scripts/serve-dist.mjs` is a zero-dependency static server that applies `vercel.json`: every
`headers` block whose `source` matches the request path, `cleanUrls`/`trailingSlash`, the SPA
rewrite for unknown routes (static directories excluded → 404), Vercel-compatible content types
(`application/wasm`, `application/octet-stream` for models). Its pure helpers are unit-tested
(`tests/unit/infra/serve-dist.test.ts`, incl. an HTTP round trip on a temporary folder).
`scripts/with-server.mjs -- <cmd>` starts it, waits for readiness, runs the command with the URL
exported and stops the server; CI's `prod-gate` job downloads the `dist` artifact and runs exactly
that.

## Selector contract (e2e ↔ UI)

`tests/e2e/helpers/app.ts` selects by accessible names only: `SEL` (0.1 controls) and `NAMES`
(0.2: "Loading tracking models", "Tracking models could not be loaded", "Retry tracking",
"Continue without tracking", `/Recording starts in \d/`, "Cancel countdown", `Playback` nav with
"Play"/"Pause"/"Seek"/"Loop", Settings groups and controls such as "Display fit", "Self-timer",
"Auto-stop", "Hold still to capture", "Ink thickness", the Diagnostics rows and "Copy diagnostics").
If a name changes, change it there only. Helpers: `fitRect(mode, box, srcW, srcH)` / `containBars`
(presentation geometry), `makeWebmFixture(page, seconds)` (in-browser WebM with a patched duration,
see `helpers/webm.ts`), `holdStill(page, sample)` (hold-still gesture), `openSettings`,
`chooseSegment`, `setSliderExtreme`, `stagePixels`/`regionMean`/`regionFraction`/`regionDiff`,
`readLoadingProgress(page)` (presence and `aria-valuenow` of the loading bar in one `evaluateAll`
call). Rule for every poll read: **use `evaluateAll`, never `count()` followed by a locator action** —
an action after a presence check autowaits on an element that vanished in between and stalls the
poll until its deadline, which reads like an app stall.

## Visual baselines

`tests/e2e/visual.spec.ts` screenshots persona × base with the skewed mock pose and
`prefers-reduced-motion: reduce` (deterministic HUD/backdrop). Baselines are committed under
`tests/e2e/__screenshots__/`; `maxDiffPixelRatio: 0.02`. All new look/persona parameters default to
the 0.1 values, and unit tests pin that (shader uniform golden table at `DEFAULT_LOOK`, persona
draw-call identity test), so the baselines must not change at default settings.

## Repo hygiene (`tests/unit/repo-hygiene.test.ts`, `scripts/hygiene.mjs`)

Scope: the tracked / deployable payload — everything under the repository root **except**
`node_modules`, `dist`, `coverage`, `playwright-report`, `test-results`, `.vercel`, `public/wasm`,
model binaries, `tests/fixtures/*.y4m`, the lockfile and dot-directories other than `.github`.
Rules: no file > 5 MB, no audio/video files, no `.env*`, no `*.log` files, no absolute paths into a
home directory, no references to retired internal planning documents outside `docs/handoffs/`
(historical notes), no forbidden strings (reel host, franchise/trademark names, creator handle,
reference-material paths), no raster images other than our own baselines/handoff screenshots, and
source policy: no browser storage, no eval/innerHTML sinks, dev hooks gated behind
`import.meta.env.DEV`/`VITE_E2E`, UI never reads `window.__alterframe`, harness folders not imported
by app code, models/wasm from our origin. Findings are reported as `path:line — rule (match)`. This
is a hygiene gate, not a security audit — see `security.md`.

## CI

`.github/workflows/ci.yml`: `check` (typecheck, lint, unit), `build` (build, verify-dist, bundle
report `--strict`, `dist` artifact), `e2e` (models + fixture caches, Chromium, the GPU suite with
the long timeouts, full Playwright), `prod-gate` (downloads `dist`, `with-server` + `test:prod-gate`)
and a non-blocking `audit` (`npm audit --omit=dev --audit-level=high`). Node 22.23 everywhere.

On a shared machine the Playwright dev server port (6220) may be taken by another run; set
`E2E_PORT=<free port>` for your own run (`playwright.config.ts` reads it), or `E2E_BASE_URL` to reuse
a server you started.
