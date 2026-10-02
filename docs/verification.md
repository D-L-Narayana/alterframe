# Verification report (integration, 2026-10-02)

What was verified, how, and what remains unverified. Numbers below are from the integrated tree on
the final commit; re-run the commands to reproduce.

## Gates

| Gate | Command | Result |
|---|---|---|
| Fresh install | `npm ci` (Node 20.20 here; CI uses 22.23) | ok, 195 packages, postinstall copies 6 wasm files |
| Typecheck | `npm run typecheck` | 0 errors (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) |
| Lint | `npm run lint` | 0 errors, 0 warnings |
| Unit | `npm test` | 50 files, **606 tests passed** (incl. repo hygiene, infra, A1 latency) |
| Build + dist gate | `npm run build` (prebuild fetches models, postbuild `verify-dist`) | JS 515.8 kB / **162.7 kB gzip** (budget 450 kB gz); models + wasm present in `dist/`; no inline scripts; 0 occurrences of `injectTracking` / `__alterframe` / `mockTracking` / `VITE_E2E` in the bundle |
| E2E (Chromium + SwiftShader, fake camera from generated Y4M, injected tracking) | `npx playwright test` | **41 passed, 2 skipped** (production-gate needs a served build) |
| Production gate against the built `dist` served with the `vercel.json` headers | `E2E_PROD_URL=… npx playwright test tests/e2e/production-gate.spec.ts` | 2 passed — no dev globals, no inline scripts |
| CSP smoke on the built bundle | private probe (headless Chromium, real MediaPipe on fake camera) | 0 CSP violations, 0 page errors, only same-origin requests, stage renders, comic/masked switch works |
| Render core GPU pixel tests | `tests/e2e/render-pixels.spec.ts` | 6/6 at 1280×720, 390×844, 1024×1024 (quad inside/outside colours, opacity blend, mirror flips video only) |
| Shader compile + look | `tests/e2e/shaders.spec.ts` + W5 `verify.mjs` | 12 passes compile; 38/38 pixel checks after the ink change |
| Accessibility | `tests/e2e/a11y.spec.ts` (axe) | onboarding, stage+controls, settings sheet, help dialog: 0 serious/critical; tab order; dialog focus trap + restore |
| Keyboard | a11y + window/director/recorder specs | `1/2/3 B H D R S F ? Esc` exercised |
| Recording / snapshot | `tests/e2e/recorder.spec.ts` + W9 browser inspection | mp4 download > 1 kB with `alterframe-YYYYMMDD-HHMMSS.*` names; PNG snapshot valid; centre-crop sizes 1280×720 / 1080×1920 / 1920×1080 / 1080×1080 |
| Camera denied / unavailable | `tests/e2e/camera-denied.spec.ts` | error panel with retry + file fallback; polite live region |
| Privacy | hygiene test + smoke | no `localStorage`/`sessionStorage`/IndexedDB; zero third-party requests after load |
| Headers | `tests/e2e/headers.spec.ts` | CSP (`wasm-unsafe-eval`, `connect-src 'self'`), Permissions-Policy camera=(self), COOP, nosniff, cache policy |

## Real inference (not mocks)

* **Still photo (private, not in repo):** HandLandmarker 2/2 hands (scores 0.97/0.99), FaceLandmarker 478 landmarks, selfie segmentation 256² — CPU and GPU delegates (W3 `verify.mjs`).
* **Real video through the app's "Open a video file" path** (private clip, 85 distinct frames processed at slow playback in SwiftShader): two hands detected on 66 % of processed frames, any hand 93 %, face 85 %, segmentation 100 %; window visible 67 %. The weakest phases are where the footage itself is stylized or hands leave the frame. The mask aligned with the tracked face centre to within 0.3 % of frame width.
* SwiftShader CPU timings in this sandbox: hands ≈ 1.1–1.8 s, face ≈ 0.2–0.5 s, segmentation ≈ 0.03–0.2 s per frame. **These are software-rendering numbers and say nothing about real hardware.**

## Criteria vs. limits

| Criterion | Status |
|---|---|
| A1 ≤ 2 frames smoothing lag | One-Euro defaults retuned (`beta 0.02 → 1.5`): mid-sweep lag 2 frames, settles within 2 frames at 60 fps, rest-jitter variance < 5 % of raw at realistic noise (`tests/unit/tracking/latency.test.ts`). Measured on synthetic motion, not on a camera. |
| A2 hold/fade | unit-tested (W7) |
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
| Performance ≥ 24 fps on a mid laptop | **Not verifiable here** (no GPU, no camera). Adaptive quality is the mitigation. Needs a user run. |

## Honest scope

* The window content is a **real-time procedural approximation**: bilateral smoothing → luminance
  quantisation → Sobel ink (edges from the pre-blurred video, not the quantised image — fixed at
  integration after a contour-mesh artefact on real footage) → halftone/paper grade, plus
  segmentation-based background replacement and landmark-driven vector overlays. It does not redraw
  clothing, hair or scenery and is not a hand-drawn or generative transformation.
* Cel quantisation can split a face lit from one side into two tone bands; softened (`u_soft 0.3`)
  but inherent to the style.
* The selfie segmenter often loses thin fingers; the paper backdrop can show through hands.
* Real-camera behaviour (device switching, unplug, fps, latency feel) must be confirmed by a user on
  the deployed URL.

## Artefacts (private, outside the repository)

`/home/user/workspace/reel-recreation/integration-reports/` — e2e logs, CSP probe output and
screenshots, real-footage metrics (`real-footage/slow-summary.json`), persona screenshots on a
synthetic person (`personas/`), shader A/B crops.
