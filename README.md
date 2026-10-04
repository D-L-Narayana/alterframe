# AlterFrame

**Hold a window between your hands and reveal your illustrated alter ego.**

Live: https://alterframe-xi.vercel.app · Source: https://github.com/D-L-Narayana/alterframe · Verification: [docs/verification.md](docs/verification.md) · Changes: [CHANGELOG.md](CHANGELOG.md)

AlterFrame is a browser app. Point your webcam at yourself, raise both hands in an "L" (index up,
thumb inward), and the quadrilateral stretched between your fingertips becomes a window into a
live, stylized version of the same scene: a paper-and-ink portrait, a masked hero in a neon city,
or a web-patterned suit. Thin tracking callouts decorate the window corner and your eyes. Outside
the window you can keep the live camera or switch the whole frame to a comic look.

Everything runs on your device. Camera frames never leave the browser.

> Inspiration: this is an original, real-time procedural take on a popular style of hand-window
> "alter ego" webcam effect. All artwork, shaders and code are our own; no third-party footage,
> music, character names or logos are used.

## How it works

```
camera / video file ─▶ MediaPipe (hands · face · selfie segmentation, WebAssembly, on-device, lazy chunk)
                        └▶ window quad from index + thumb tips (One-Euro smoothed, optional corner spring)
                        └▶ gestures: hands-together → persona cycle · hold-still → hands-free capture
                        └▶ persona overlays + backdrops (procedural Canvas2D vector art)
                        └▶ WebGL2 stylization passes (smooth → quantize → ink → halftone → grade), look-tunable
                        └▶ compositor: base layer (live/comic) + window layer + HUD → <canvas> (Fill or Fit)
                        └▶ MediaRecorder (self-timer, auto-stop) / snapshot PNG · JPEG · WebP (16:9 · 9:16 · 1:1)
```

* **Window** — four corners = index-fingertip and thumb-tip of each hand, visible whenever two
  hands are tracked (even as a thin slit). Hold 300 ms / fade 150 ms when a hand is lost.
  Convex ordering by default; a "faithful" mode keeps the self-intersecting bow-tie look.
* **Personas** — `portrait` (paper-white room line-art, colour kept on the person), `masked`
  (neon city backdrop, opaque white mask with pink lens outlines that squint with your eyes), `suit`
  (pink/white/black web suit with an original spider emblem). Overlays follow face landmarks, blink
  and mouth motion; the city backdrop drifts slightly with your head (frozen under reduced motion).
* **Base styles** — `live` or full-frame `comic` stylization. HUD is white on live, red on comic.
* **Gestures (optional)** — bring both hands together for ≥ 500 ms, then open: the persona advances.
  Hold the window perfectly still for the hold time (1.5 s by default): a snapshot or recording
  starts hands-free ("Hold still to capture"). Both are our additions, not something the effect requires.
* **Director** — replays a five-step scene sequence with fixed durations.
* **Capture** — record WebM/MP4 of the composite (including HUD) with an optional self-timer
  (3/5/10 s) and auto-stop (10–60 s), or save a snapshot as PNG, JPEG or WebP.

Honest scope: the illustration is a real-time **procedural approximation** (GPU stylization of your
camera frame + segmentation-based background replacement + vector overlays). It is not a
generative or hand-drawn transformation and will not redraw clothing or scenery.

## What is new in 0.2

* **Visible loading and a recovery path** — a determinate "Loading tracking models" bar; when the
  models cannot be fetched a card offers **Retry tracking** or **Continue without tracking** (the
  live video keeps running). The models download in parallel with the camera prompt.
* **Hands-free capture** — Self-timer, Auto-stop and the hold-still gesture; the countdown is drawn
  inside the frame and announced ("Recording starts in 3"). `T` starts a timed recording; `Esc`
  cancels a countdown. A recording in progress is saved when you leave the stage or switch sources.
* **File playback controls** — for the "Open a video file" path: Play/Pause, a Seek slider, Loop,
  and keys `P` `[` `]` `L`. The frame re-renders while paused when you change persona or settings.
* **Display fit** — Fill (crop, as before) or Fit (letterbox: the whole frame is visible with black
  bars; recordings and snapshots capture the canvas, so they include the bars).
* **Look** — Ink thickness, Ink threshold, Halftone, Saturation, Colour bands, Grain, Overlay
  strength, with a Reset. Defaults reproduce the 0.1 render exactly.
* **Quality** — tracking resolution (Full/480p/360p) and face stride as manual controls and as new
  rungs of the adaptive ladder, which now lowers render scale first when rendering (not tracking)
  dominates the frame time. Shader programs are warmed up in idle time after start.
* **Diagnostics** — Settings → Diagnostics shows tracking delegates (GPU/CPU), frame/tracking/render/GPU
  times, the quality rung, renderer and source details; **Copy diagnostics** puts JSON on the clipboard.
  Numbers describe the machine they were measured on (under software rendering "GPU time" is CPU time).

## Privacy

* All processing happens on-device in your browser (WebAssembly + WebGL2).
* After the page and model files load, the app makes **no network requests** — enforced by the
  deployed `Content-Security-Policy` (`connect-src 'self'`) and checked by the production gate.
* No analytics, no accounts, no cookies, no local storage. Settings live in memory for the session.
* Recordings and snapshots are produced locally and only saved when you click Download.
* The camera is requested only after you click **Use camera**. Denied or missing cameras fall
  back to **Open a video file** (processed locally via an object URL).

## Controls

| Action | UI | Key |
|---|---|---|
| Persona portrait / masked / suit | segmented control | `1` / `2` / `3` |
| Base live ↔ comic | toggle | `B` |
| HUD on/off | toggle | `H` |
| Director play/stop | button | `D` |
| Record start/stop (after the Self-timer when one is set) | button (shows mm:ss, and the auto-stop remaining) | `R` |
| Timed recording (Self-timer value, 3 s when it is Off; again cancels) | — | `T` |
| Snapshot (PNG / JPEG / WebP) | button | `S` |
| Mirror | toggle | `M` |
| FPS badge | — | `F` |
| Play / pause the video file | Playback bar | `P` |
| Seek the video file −1 s / +1 s | Seek slider | `[` / `]` |
| Loop the video file | Loop switch | `L` |
| Settings sheet | button | — |
| Help / keyboard map | button | `?` |
| Cancel countdown → close dialog → stop recording | — | `Esc` |

Settings groups: **Window & gestures** (corner ordering, gesture cycle, hold/fade, gesture arm time,
corner smoothing, hold still to capture, hold time), **Quality** (adaptive quality, render scale,
segmentation stride, tracking resolution, face stride), **Look**, **HUD** (callouts, colour
auto/white/red), **Display** (mirror, display fit, fps, reduce motion — also honours
`prefers-reduced-motion` — thin-slit glitch, debug landmarks), **Capture** (aspect, self-timer,
auto-stop, snapshot format) and **Diagnostics**.

## Development

Requirements: Node `^20.19.0 || >=22.12.0` (Vite 8 / ESLint 10 engine ranges), npm 10.

```bash
npm ci                 # installs deps; postinstall copies the MediaPipe wasm into public/wasm
npm run dev            # predev fetches models into public/models, then Vite on :5173
npm run typecheck      # strict TS
npm run lint           # ESLint flat config
npm test               # Vitest unit suites (incl. repo hygiene / infra checks)
npm run fixture        # generates tests/fixtures/hands*.y4m (~135 MB, gitignored) + schedule JSON
npm run test:e2e       # Playwright (Chromium, fake camera fed by the fixture, mock tracking)
npm run build          # tsc + vite build; postbuild verifies dist has models, wasm, no inline scripts
node scripts/bundle-report.mjs --strict   # per-chunk sizes; budgets: total JS ≤ 450 kB gz, entry ≤ 128 kB gz, MediaPipe-free entry
npm run serve:dist                        # serve dist/ on :4173 with the vercel.json headers, rewrites and cleanUrls
node scripts/with-server.mjs -- npm run test:prod-gate   # production gate against serve-dist (headers, CSP, no dev hooks)
node scripts/hygiene.mjs --git            # release hygiene scan
```

Models (`*.task`, `*.tflite`) and wasm are **not committed**; `prebuild`/`predev`/`postinstall`
regenerate them so a clean `npm ci && npm run build` yields a complete `dist/`.

Project layout and public module APIs: `docs/modules.md`; architecture and data flow:
`docs/architecture.md`; contracts: `src/types/**`. Testing strategy: `docs/testing.md`. Security
model: `docs/security.md`. Release checklist: `docs/release.md`.

### Bundle (v0.2 build, Vite build output, decimal kB)

Entry chunk `index-*.js` 387.4 kB raw / **125.1 kB gzip** (react-dom ≈ 53 % of it; our own code
≈ 155 kB raw), lazy `tracking-*.js` 170.7 kB / 52.1 kB gzip (MediaPipe + telemetry guard), CSS
24.8 kB / 5.2 kB gzip, total JS 177.2 kB gzip. Budgets (`scripts/bundle-report.mjs`): total
≤ 450 kB gz, entry ≤ 128 kB gz (measured + ≈ 2 % headroom) and a MediaPipe-free entry, enforced in
CI with `--strict`. Models (≈ 11.8 MB) and wasm (≈ 35 MB) are loaded on demand after the shell
paints and cached for a day by the deployment headers.

## Browser support

Chromium-based browsers and Safari 17+ on desktop and mobile (WebGL2, `getUserMedia`,
`MediaRecorder`). Firefox works with a `requestAnimationFrame` fallback for frame callbacks;
MP4 recording is only offered where the browser supports it (WebM otherwise); JPEG/WebP snapshots
fall back to PNG where the browser cannot encode them.

## Licences

Code: MIT (see `LICENSE`). Third-party components — MediaPipe (Apache-2.0), Inter (OFL-1.1),
React / zustand / Vite (MIT) — are listed with sources in `NOTICE.md`.
