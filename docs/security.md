# Security and privacy model

## Threat model in one paragraph

A static web app that touches the user's camera. The assets we must protect are camera frames and
recordings; the risks are exfiltration (network), injection (XSS → camera access), and
third-party supply chain. There is no server, no auth, no persistence.

## Controls

| Control | Where | Verified by |
|---|---|---|
| CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` | `vercel.json` | declared: `tests/unit/infra/vercel.test.ts`, `tests/e2e/headers.spec.ts`; **served**: `tests/e2e/production-gate.spec.ts` against `npm run serve:dist` (CI `prod-gate` job) and against the deployment (`E2E_PROD_URL`), plus `curl -I` at release |
| `Permissions-Policy: camera=(self), microphone=()` + geolocation/payment/usb off | `vercel.json` (also Vite dev server) | same |
| `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, COOP/CORP same-origin | `vercel.json` | same; `scripts/serve-dist.mjs` reproduces every header block locally |
| Zero CSP violations while the app runs (incl. the tracking runtime: wasm + models) | — | `production-gate.spec.ts`: `securitypolicyviolation` listener installed before any script + console capture, across onboarding → camera → stage → Settings → 1 s recording → tracker settled → 65 s idle |
| No inline scripts in `index.html` | Vite default | `scripts/verify-dist.mjs` (postbuild), `production-gate.spec.ts` |
| No third-party requests at runtime (models + wasm same-origin; MediaPipe's usage logger neutralised by `src/tracking/telemetryGuard.ts`) | `scripts/copy-wasm.mjs`, `fetch-models.mjs` at build time; tracking module guard | `smoke.spec.ts` network log (dev), `production-gate.spec.ts` request log over the whole workflow + 65 s idle (production build), `verify-dist.mjs` CDN grep, hygiene test |
| No `eval` / `new Function` / `innerHTML` / `dangerouslySetInnerHTML` | source policy | hygiene test, ESLint `no-eval`, `no-implied-eval`, `no-new-func` |
| No browser storage (settings in memory) | project override | hygiene test |
| Camera requested only after a user click; denied/unavailable handled | app shell + media | `camera-denied.spec.ts` |
| File input handled as object URL only | media | review item for the lead (not automatable) |
| Dev-only test hooks (`window.__alterframe`, `injectTracking`, `?mockTracking=1`) never in production | gating on `import.meta.env.DEV`/`VITE_E2E` | hygiene test (gating grep), `verify-dist.mjs` string grep, `production-gate.spec.ts` on the served build |
| Dependency pinning | `package.json` exact versions, `package-lock.json`, `npm ci` | infra test (lock in sync); advisory CI job `npm audit --omit=dev --audit-level=high` (`continue-on-error`, `.npmrc` keeps audit quiet during install) |
| Repository hygiene (no logs, private paths, retired planning documents, forbidden names, media, env files) | `tests/unit/repo-hygiene.test.ts`, `scripts/hygiene.mjs --git` | CI `check` job + release step |

`'wasm-unsafe-eval'` is required by MediaPipe's wasm runtime. It allows WebAssembly compilation
from same-origin bytes only; it does not allow script `eval`.

## CSP decision (0.2): `style-src 'self'`, no `'unsafe-inline'`

0.1 shipped `style-src 'self' 'unsafe-inline'` on the assumption that React inline styles and the
Fontsource `@font-face` declarations needed it. 0.2 tested the assumption instead of carrying it:

* **Method** — `npm run build`, then the production gate against the built `dist` served by
  `scripts/serve-dist.mjs` with a copy of `vercel.json` whose CSP had `style-src 'self'`; the gate
  installs a `securitypolicyviolation` listener before any app script runs and also captures console
  refusals, then walks onboarding → Use camera → stage → Settings → close → 1 s recording and waits
  for the real tracking runtime (wasm + three models) to settle.
* **Environment** — Playwright 1.63 Chromium, headless, SwiftShader WebGL, fake camera fed by the
  generated fixture; no mock tracking (the real MediaPipe runtime ran).
* **Result** — **0 `style-src` violations** (two runs: 3.7 minutes and 40 seconds of the loaded app).
  The only inline-style candidate in the source is the progress-bar width in `src/app/Stage.tsx`;
  React sets it through the CSSOM (`element.style.width = …`), which `style-src` does not govern —
  the directive restricts `style` attributes in markup, `<style>` elements and stylesheet URLs. The
  Inter `@font-face` rules are part of the bundled stylesheet (`assets/index-*.css`), not inline.
* **Decision** — `'unsafe-inline'` removed from `style-src` in `vercel.json`;
  `tests/unit/infra/vercel.test.ts` and `tests/e2e/headers.spec.ts` now reject `'unsafe-inline'`
  in every directive, and `production-gate.spec.ts` asserts the served CSP string equals the
  declared one, so a regression (an inline `style=` attribute, a `<style>` tag) fails the gate
  rather than silently widening the policy.

## Finding and fix: MediaPipe usage logger (connect-src)

The same gate run surfaced the only violations the built app produced: `@mediapipe/tasks-vision`
1.0.1 (bundled into our tracking chunk) contains a usage logger. Each task (hand landmarker, face
landmarker, image segmenter) creates one; it buffers task events and attempts a protobuf POST — with
an API key read from the wasm — to `https://odml.pa.googleapis.com/v1/log` **60 s after the task was
created** and again when the task is closed. When the request fails the logger records the error and
clears its interval, so each task makes at most one periodic attempt. Evidence from the decision run
(SwiftShader / sandbox, real runtime): 3 `connect-src` violations in a 3.7-minute run (source
`assets/tracking-*.js`, one per task), 0 in a 40-second run that ended before the first flush.

Two lines of defence, both without a dependency change:

1. **Telemetry guard in the tracking module** (`src/tracking/telemetryGuard.ts`): an idempotent
   guard on the global `fetch` that rejects requests to `odml.pa.googleapis.com` locally — no
   network call is ever made, MediaPipe's sender then disables itself — and records the blocked
   attempt in `TrackerInfo.warnings` (visible in Diagnostics). This works in **every** environment,
   including the Vite dev server, which sends no CSP.
2. **`connect-src 'self'`** in the deployed CSP: had the guard not been there, the browser would have
   blocked the request anyway — no data leaves the device.

The production gate is the proof: it keeps the loaded app alive for 65 s after the tracker settles
(so every task's first flush falls inside the observed window) and fails on **any** CSP violation
and on **any** request to another origin. Neither assertion may be weakened.

## Not covered (be honest in reports)

* The hygiene scan is a **string and file-type gate**; it does not prove the absence of
  vulnerabilities. The CI `npm audit` job is advisory (non-blocking) and covers runtime
  dependencies only; no penetration test has been run.
* The served-headers check proves what `serve-dist` and the deployment send at the time of the run;
  CDN configuration drift must be re-checked after every deploy (`curl -I`, live production gate).
* The Vite dev server does not apply the CSP (only the Permissions-Policy header); dev-mode e2e
  runs therefore prove behaviour, not policy — the production gate does.
* WebGL/wasm runtime bugs in the browser are out of scope.

## Release-time checklist

1. `npm run check && npm run build` (postbuild verifies dist payload, no inline scripts, no dev hooks).
2. `node scripts/with-server.mjs -- npm run test:prod-gate` — 4 passed: no dev hooks, no inline
   scripts, 0 CSP violations + 0 foreign requests, served headers equal `vercel.json`.
3. `node scripts/hygiene.mjs --git` — zero findings.
4. `npm audit --omit=dev` reviewed; record decisions in the release notes.
5. Deploy, then `curl -I <url>` (CSP string exactly as in `vercel.json`),
   `curl -sI <url>/models/hand_landmarker.task` (200, content-length 7819105),
   `curl -sI <url>/wasm/vision_wasm_internal.wasm` (200, `application/wasm`), and
   `E2E_PROD_URL=<url> npx playwright test tests/e2e/production-gate.spec.ts`.
6. Open the deployment with DevTools: no CSP violations, only same-origin requests, camera prompt
   only after clicking **Use camera**.
