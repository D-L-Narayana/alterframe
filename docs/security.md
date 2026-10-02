# Security and privacy model

## Threat model in one paragraph

A static web app that touches the user's camera. The assets we must protect are camera frames and
recordings; the risks are exfiltration (network), injection (XSS → camera access), and
third-party supply chain. There is no server, no auth, no persistence.

## Controls

| Control | Where | Verified by |
|---|---|---|
| CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` | `vercel.json` | `tests/e2e/headers.spec.ts`, `tests/unit/infra/vercel.test.ts`; live `curl -I` by the lead after deploy |
| `Permissions-Policy: camera=(self), microphone=()` + geolocation/payment/usb off | `vercel.json` (also Vite dev server) | same |
| `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, COOP/CORP same-origin | `vercel.json` | same |
| No inline scripts in `index.html` | Vite default | `scripts/verify-dist.mjs` (postbuild), `production-gate.spec.ts` |
| No third-party requests at runtime (models + wasm same-origin) | `scripts/copy-wasm.mjs`, `fetch-models.mjs` at build time | `smoke.spec.ts` network log, `verify-dist.mjs` CDN grep, hygiene test |
| No `eval` / `new Function` / `innerHTML` / `dangerouslySetInnerHTML` | source policy | hygiene test, ESLint `no-eval`, `no-implied-eval`, `no-new-func` |
| No browser storage (settings in memory) | project override | hygiene test |
| Camera requested only after a user click; denied/unavailable handled | W1/W2 | `camera-denied.spec.ts` |
| File input handled as object URL only | W2 | review item for the lead (not automatable) |
| Dev-only test hooks (`window.__alterframe`, `injectTracking`, `?mockTracking=1`) never in production | W2 gating on `import.meta.env.DEV`/`VITE_E2E` | hygiene test (gating grep) + `production-gate.spec.ts` on a production preview |
| Dependency pinning | `package.json` exact versions, `package-lock.json`, `npm ci` | infra test (lock in sync); `npm audit` is manual (`.npmrc` disables audit noise during install) |

`'wasm-unsafe-eval'` is required by MediaPipe's wasm runtime; `'unsafe-inline'` for styles is
required by React inline styles and Fontsource `@font-face` declarations. Neither allows script
execution from third parties.

## Not covered (be honest in reports)

* The hygiene scan is a **string and file-type gate**; it does not prove the absence of
  vulnerabilities. No penetration test or dependency CVE audit has been run in CI.
* CSP is declared in `vercel.json`; whether the CDN actually serves it must be checked on the
  deployment (`curl -I https://<host>/`). The Vite dev server does not apply the CSP.
* WebGL/wasm runtime bugs in the browser are out of scope.

## Release-time checklist

1. `npm run check && npm run build` (postbuild verifies dist payload, no inline scripts).
2. `node scripts/hygiene.mjs --git` after `git init` — zero findings.
3. `npm audit --omit=dev` reviewed; record decisions in the release notes.
4. Deploy, then `curl -I <url>` and `curl -sI <url>/models/hand_landmarker.task` (200, content-length 7819105).
5. Open the preview in a browser with DevTools: no CSP violations, only same-origin requests,
   camera prompt only after clicking **Use camera**.
