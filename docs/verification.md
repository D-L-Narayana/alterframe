# Verification report

What was verified, how, and what remains unverified. Every number is a snapshot of one specific run
on the stated commit in the stated environment; re-run the protocol to reproduce. "Verified" always
means verified **in that environment** — nothing here is a claim about real-camera hardware.
Private run artefacts (logs, screenshots, probe output) are kept outside the repository; this file
records only commands, counts and CI run ids.

## Protocol (run on the release commit)

| # | Gate | Command | Environment to label |
|---|---|---|---|
| 1 | Fresh install | `npm ci` | Node version, OS |
| 2 | Typecheck | `npm run typecheck` | — |
| 3 | Lint | `npm run lint` | — |
| 4 | Unit | `npm test` | Node version; note that the GPU suite skips without Chromium |
| 5 | GPU pixel tests | `npx vitest run tests/unit/render-core/gpu.test.ts --hookTimeout 300000 --testTimeout 120000` | Chromium version, SwiftShader or GPU |
| 6 | Build + dist gate | `npm run build` | — |
| 7 | Bundle budgets | `node scripts/bundle-report.mjs --strict` | — |
| 8 | E2E | `npm run fixture && npx playwright test` (one spec per command on small machines) | Chromium version, SwiftShader / GPU, fake camera from the generated Y4M, injected tracking |
| 9 | Production gate (local) | `node scripts/with-server.mjs -- npm run test:prod-gate` | same as 8, real tracking runtime |
| 10 | Hygiene | `node scripts/hygiene.mjs --git` | — |
| 11 | Deployment headers | `curl -I https://<host>/`, `curl -sI https://<host>/models/hand_landmarker.task`, `curl -sI https://<host>/wasm/vision_wasm_internal.wasm` | CDN edge, date |
| 12 | Production gate (live) | `E2E_PROD_URL=https://<host> npx playwright test tests/e2e/production-gate.spec.ts` | as 8 |
| 13 | Real camera (manual) | open the deployment, allow the camera, raise both hands; record 10 s; snapshot; Fit/Fill; Diagnostics → Copy | device, browser, GPU — the only step with real hardware |

## Run snapshot — 0.2.0 integration (2026-10-04, pre-release)

Environment for every browser row: headless Chromium 153.0.8010.12 (Playwright 1.63.0, build 1243)
with **SwiftShader** software WebGL on a 2-CPU sandbox without a camera or GPU; the fake camera plays
the generated `tests/fixtures/hands*.y4m`; most app specs inject tracking frames, `loading.spec.ts`
and the production gate run the real MediaPipe runtime. Node 20.20.1 locally (CI pins 22.23).
Nothing below is a claim about real hardware. Steps 11–13 run after the deployment, not here.

| Gate | Result | Environment | Evidence |
|---|---|---|---|
| 1 Fresh install | `npm ci --ignore-scripts` → 195 packages; `node scripts/copy-wasm.mjs` → 6 wasm files (35.4 MB); `node scripts/fetch-models.mjs` → 3 models (11.8 MB) | Node 20.20.1, Linux | integration log |
| 2 Typecheck | 0 errors (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) | — | integration log |
| 3 Lint | 0 errors, 0 warnings (`eslint .`) | — | integration log |
| 4 Unit | 70 files / **1045 tests passed** (GPU suite excluded here and run as gate 5) | Node 20.20.1 | integration log |
| 5 GPU pixel tests | **20/20** (cover + contain fits, warm-up, `gpuMs`, context loss); `EXT_disjoint_timer_query_webgl2` present, `gpuMs ≈ 11–16 ms` = SwiftShader CPU time | Chromium 153 / SwiftShader | integration log |
| 6 Build + dist gate | entry `index-*.js` 387.8 kB / 125.4 kB gzip, `tracking-*.js` 170.7 kB / 52.1 kB gzip, CSS 24.8 kB / 5.2 kB gzip (Vite output, decimal kB); `verify-dist` ok — models + wasm present, no inline scripts, no dev-hook strings | — | integration log |
| 7 Bundle budgets | `--strict` exit 0: total JS gzip within 450 kB, entry within 128 kB, `entry-chunk MediaPipe check: OK` (0 MediaPipe markers in the entry) | — | integration log |
| 8 E2E | **60 passed / 0 skipped**, retries disabled (`--retries 0`), five groups of one `playwright test` each on the same source: smoke+headers+camera-denied+recorder+director 15/15 · window+loading+fit 11/11 · capture-timer+dwell+transport+diagnostics 10/10 · look+a11y 9/9 · render-pixels+shaders+visual 15/15 (6 visual baselines unchanged at default settings). Earlier runs of the same groups during the review are recorded below, including one environmental skip and the failures that led to the fixes | Chromium 153 / SwiftShader, fake camera, injected tracking (real tracker in `loading` and the smoke fps check) | integration logs |
| 9 Production gate (local) | **4 passed** against `scripts/serve-dist.mjs` serving the built `dist` with the `vercel.json` headers: no dev hooks with `?mockTracking=1`, no inline scripts, **0 CSP violations and 0 requests to other origins** across onboarding → camera → settings → 1 s recording → tracker settled → 65 s idle, served headers equal `vercel.json` | as 8, real tracking runtime | integration log |
| 10 Hygiene | `node scripts/hygiene.mjs --git` → 0 findings; `tests/unit/repo-hygiene.test.ts` 20/20 | — | integration log |
| 11 Deployment headers | CSP equal to `vercel.json`; model 200 / 7819105 B; wasm 200 `application/wasm` | CDN, date | **pending** — after the deploy (`curl -I` output kept private) |
| 12 Production gate (live) | `E2E_PROD_URL=<host> npx playwright test tests/e2e/production-gate.spec.ts` | as 8 | **pending** — after the deploy |
| 13 Real camera | device switching, unplug, fps, latency feel, hold-still comfort | device, browser | **pending** — needs a user run |

Defects found and fixed during integration and the independent review, each with a failing test first:
(a) MediaPipe rejected a frame with `Packet timestamp mismatch … free_memory` when the runtime re-rendered
a paused frame 1 µs after the previous one (float-millisecond timestamps truncate to the same microsecond
packet) — the tracker now hands MediaPipe integer milliseconds that strictly increase
(`tests/unit/tracking/timestamps.test.ts`); (b) `@mediapipe/tasks-vision` 1.0.1 tries to POST usage
statistics to a Google endpoint 60 s after each task starts — blocked by the deployed CSP, now also refused
locally by `src/tracking/telemetryGuard.ts` (`security.md`); (c) the file-playback Seek slider re-seeked
the clip to its previous position (controlled range input restored to the stale store value between the
browser's `input` and `change` events) and, once fixed, could revive a completed seek when the clip
returned to the same position — the slider now renders the pending seek intent until the store
acknowledges it and spends it afterwards (`src/app/transportSlider.ts`; `transport.spec.ts` asserts a
real end → 00:00 Home seek and the no-revival case); (d) `play()/pause()/seek()` published their state to
the store only via the element's later event task, so the Play/Pause label and slider lagged a full
inference frame on a busy main thread — the mirror is now published in the command's own task
(`src/media/fileSource.ts`, `tests/unit/media/transport.test.ts`).

Test-side fixes from the review, none weakening a product assertion: the loading poll reads presence
and value in one browser-side step (`readLoadingProgress`; a count-then-attribute race had autowaited on a
removed progress bar), and the smoke fps check asserts the badge contract (toggle, frame-counter liveness
across the test, badge == rounded live rate) instead of requiring the number to *change* within 10 s.
Review-run history on this host (kept private with traces): group B once reported 10 passed + 1
environmental skip (`window.spec` "short together" — frame pacing under load could not hold a pose under
500 ms; the same check passed alone on an idle host); group C failed once on the Seek slider (fix c) and
once on a Pause click whose label flip waited for the next inference frame while the main thread was
stalled 15–40 s per protocol step (fix d); group A failed twice on the old fps expectation. Every group
then passed completely on the final source with retries disabled. Workflow walkthroughs with
screenshots (loading bar, countdown numeral, JPEG snapshot, Fit letterbox at desktop and phone sizes,
look sliders, dwell ring, failure card → Retry, file transport incl. pause/seek/loop) were taken on both
the dev server and the served production build; they are private run artefacts.

### Criteria vs. limits (0.2)

| Criterion | How it is checked | Status at integration |
|---|---|---|
| Loading progress visible, failure recoverable | `loading.spec.ts` (real tracker; blocked models → card → Retry) | 3/3 — bar 0→100 and gone; failure card with Retry/Continue; retry completes |
| Self-timer / auto-stop / T / Esc | `capture-timer.spec.ts`; `tests/unit/app/useCapture.test.ts` (fake timers) | 4/4 e2e; 15 unit |
| Hold-still capture | `dwell.spec.ts`; `tests/unit/interaction/dwell.test.ts` | 2/2 e2e (PNG within ~4 s, exactly once; Off never captures); 27 unit |
| File transport | `transport.spec.ts`; `tests/unit/media/transport.test.ts`; `tests/unit/app/transportSlider.test.ts` | 2/2 e2e (Pause/Play with same-task state mirror, `P`, slider Home from a clip parked at the end → 00:00, no stale-intent revival after `]`×2, `[`/`]`, `S` while paused, Loop + `L`, ends paused); 16 + 8 unit |
| Display fit (contain bars black, nothing cropped) | `fit.spec.ts`; `tests/unit/render-core/fit.test.ts`; GPU suite contain cases | 2/2 e2e (bars > 98 % black, centre shows video, Fill restores); 25 + 3 GPU |
| Look tuning, defaults identical to 0.1 | `look.spec.ts`; shader golden table; persona identity test; visual baselines unchanged | 2/2 e2e; 58 shader + 6 identity unit; 6/6 baselines identical |
| Diagnostics + copy | `diagnostics.spec.ts` | 2/2 (rows, 2 Hz refresh, clipboard JSON with `fps`/`quality`/`tracker`/`source`) |
| Lazy MediaPipe chunk, entry ≤ 128 kB gz | `node scripts/bundle-report.mjs --strict` | exit 0; entry 125.4 kB gzip (Vite), MediaPipe only in `tracking-*.js` |
| 0 CSP violations on the built app | `production-gate.spec.ts` via serve-dist and live | local: 0 violations, 0 foreign requests (CSP decision: see `security.md`); live: pending |
| axe 0 serious/critical on every screen | `a11y.spec.ts` | 7/7 (onboarding, stage, settings all groups, help, failure card, transport; tab order; focus trap) |
| Performance ≥ 24 fps on a mid laptop | **not verifiable in the sandbox** (no GPU, no camera); adaptive quality is the mitigation. Under SwiftShader the real tracker runs at 1–2 fps and the ladder steps down to 360p / stride 3 / 50 % render scale as designed | needs a user run (step 13) |

## Previous snapshot — 0.1 integration (2026-10-02)

Kept for comparison; all numbers are from that environment and commit.

| Gate | Command | Result |
|---|---|---|
| Fresh install | `npm ci` (Node 20.20 locally; CI uses 22.23) | ok, 195 packages, postinstall copies 6 wasm files |
| Typecheck | `npm run typecheck` | 0 errors (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) |
| Lint | `npm run lint` | 0 errors, 0 warnings |
| Unit | `npm test` | 50 files, **606 tests passed** (incl. repo hygiene, infra, A1 latency) |
| Build + dist gate | `npm run build` | JS 515.8 kB / **162.7 kB gzip** (single chunk at the time; budget 450 kB gz); models + wasm present; no inline scripts; 0 occurrences of `injectTracking` / `__alterframe` / `mockTracking` / `VITE_E2E` in the bundle |
| E2E (Chromium + SwiftShader, fake camera from the generated Y4M, injected tracking) | `npx playwright test` (42 tests) | CI run 37048554807 on `4a2d495`: **40 passed, 2 skipped** (the two production-gate specs need a served build). Local full runs: 40 passed / 2 skipped, except one run where `window.spec.ts › short together … does not cycle` failed its *environmental* precondition (software-rendered frames took ≥ 500 ms after a 5-minute run); since `4a2d495` that precondition is an explicit `test.skip` with the measured hold in its message. The product threshold (no persona cycle under 500 ms) is unchanged and the test passed, not skipped, in CI. |
| Production gate against the built `dist` served with the `vercel.json` headers, and against the live production URL | `E2E_PROD_URL=… npx playwright test tests/e2e/production-gate.spec.ts` | 2 passed in both cases — no dev globals, no inline scripts |
| CSP smoke on the built bundle | private probe (headless Chromium, real MediaPipe on fake camera) | 0 CSP violations, 0 page errors, only same-origin requests, stage renders, comic/masked switch works |
| Render core GPU pixel tests | `tests/e2e/render-pixels.spec.ts` | 6/6 at 1280×720, 390×844, 1024×1024 (quad inside/outside colours, opacity blend, mirror flips video only) |
| Shader compile + look | `tests/e2e/shaders.spec.ts` + the shader harness `verify.mjs` | 12 passes compile; 38/38 pixel checks after the ink change |
| Accessibility | `tests/e2e/a11y.spec.ts` (axe) | onboarding, stage+controls, settings sheet, help dialog: 0 serious/critical; tab order; dialog focus trap + restore |
| Keyboard | a11y + window/director/recorder specs | `1/2/3 B H D R S F ? Esc` exercised |
| Recording / snapshot | `tests/e2e/recorder.spec.ts` + browser inspection | mp4 download > 1 kB with `alterframe-YYYYMMDD-HHMMSS.*` names; PNG snapshot valid; centre-crop sizes 1280×720 / 1080×1920 / 1920×1080 / 1080×1080 |
| Camera denied / unavailable | `tests/e2e/camera-denied.spec.ts` | error panel with retry + file fallback; polite live region |
| Privacy | hygiene test + smoke | no `localStorage`/`sessionStorage`/IndexedDB; zero third-party requests after load |
| Headers | `tests/e2e/headers.spec.ts` | CSP (`wasm-unsafe-eval`, `connect-src 'self'`), Permissions-Policy camera=(self), COOP, nosniff, cache policy |

### Real inference (not mocks) — 0.1

* **Still photo (private, not in repo):** HandLandmarker 2/2 hands (scores 0.97/0.99), FaceLandmarker 478 landmarks, selfie segmentation 256² — CPU and GPU delegates (tracking harness `verify.mjs`).
* **Real video through the app's "Open a video file" path** (private clip, 85 distinct frames processed at slow playback in SwiftShader): two hands detected on 66 % of processed frames, any hand 93 %, face 85 %, segmentation 100 %; window visible 67 %. The weakest phases are where the footage itself is stylized or hands leave the frame. The mask aligned with the tracked face centre to within 0.3 % of frame width.
* SwiftShader CPU timings in that sandbox: hands ≈ 1.1–1.8 s, face ≈ 0.2–0.5 s, segmentation ≈ 0.03–0.2 s per frame. **These are software-rendering numbers and say nothing about real hardware.**

### Criteria vs. limits — 0.1

| Criterion | Status |
|---|---|
| A1 ≤ 2 frames smoothing lag | One-Euro defaults retuned (`beta 0.02 → 1.5`): mid-sweep lag 2 frames, settles within 2 frames at 60 fps, rest-jitter variance < 5 % of raw at realistic noise (`tests/unit/tracking/latency.test.ts`). Measured on synthetic motion, not on a camera. |
| A2 hold/fade | unit-tested |
| A3–A6 persona looks | procedural approximation; see "Honest scope" |
| A7 HUD | unit + pixel test (white on live, red on comic, hidden with `H`) |
| A8 gesture cycle | unit + e2e (exactly one cycle after ≥ 500 ms together) |
| A9 Director | unit + e2e (step 1 after 13.8 s) |
| A10 capture | e2e + browser inspection |
| A11 keyboard / axe | e2e |
| A12 denied → fallback | e2e |
| A13 adaptive quality | unit; observed stepping down under SwiftShader load |
| A14 headers / no third-party | unit (vercel.json) + smoke; live check after deployment with `curl -I` |
| A15 repo hygiene | unit (forbidden strings, raster images, > 5 MB files, reference paths) |
| Performance ≥ 24 fps on a mid laptop | **Not verifiable there** (no GPU, no camera). Adaptive quality is the mitigation. Needs a user run. |

## Honest scope

* The window content is a **real-time procedural approximation**: bilateral smoothing → luminance
  quantisation → Sobel ink (edges from the pre-blurred video, not the quantised image) → halftone /
  paper grade, plus segmentation-based background replacement and landmark-driven vector overlays.
  It does not redraw clothing, hair or scenery and is not a hand-drawn or generative transformation.
* Cel quantisation can split a face lit from one side into two tone bands; softened (`u_soft 0.3`)
  but inherent to the style.
* The selfie segmenter often loses thin fingers; the paper backdrop can show through hands.
* Real-camera behaviour (device switching, unplug, fps, latency feel, hold-still comfort) must be
  confirmed by a user on the deployed URL.
