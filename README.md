# AlterFrame

**Hold a window between your hands and reveal your illustrated alter ego.**

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
camera / video file ─▶ MediaPipe (hands · face · selfie segmentation, WebAssembly, on-device)
                        └▶ window quad from index + thumb tips (One-Euro smoothed)
                        └▶ persona overlays + backdrops (procedural Canvas2D vector art)
                        └▶ WebGL2 stylization passes (smooth → quantize → ink → halftone → grade)
                        └▶ compositor: base layer (live/comic) + window layer + HUD → <canvas>
                        └▶ MediaRecorder / PNG snapshot (16:9 · 9:16 · 1:1)
```

* **Window** — four corners = index-fingertip and thumb-tip of each hand, visible whenever two
  hands are tracked (even as a thin slit). Hold 300 ms / fade 150 ms when a hand is lost.
  Convex ordering by default; a "faithful" mode keeps the self-intersecting bow-tie look.
* **Personas** — `portrait` (paper-white room line-art, colour kept on the person), `masked`
  (neon city backdrop, opaque white mask with pink lens outlines), `suit` (pink/white/black web
  suit with an original spider emblem). Overlays follow face landmarks, blink and mouth motion.
* **Base styles** — `live` or full-frame `comic` stylization. HUD is white on live, red on comic.
* **Gesture (optional)** — bring both hands together for ≥ 500 ms, then open: the persona advances.
  This is our addition, not something the effect requires.
* **Director** — replays a five-step scene sequence with fixed durations.
* **Capture** — record WebM/MP4 of the composite (including HUD) or save a PNG snapshot.

Honest scope: the illustration is a real-time **procedural approximation** (GPU stylization of your
camera frame + segmentation-based background replacement + vector overlays). It is not a
generative or hand-drawn transformation and will not redraw clothing or scenery.

## Privacy

* All processing happens on-device in your browser (WebAssembly + WebGL2).
* After the page and model files load, the app makes **no network requests** — enforced by the
  deployed `Content-Security-Policy` (`connect-src 'self'`) and checked in CI.
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
| Record start/stop | button (shows mm:ss) | `R` |
| Snapshot PNG | button | `S` |
| Mirror | toggle | `M` |
| FPS badge | — | `F` |
| Settings sheet | button | — |
| Help / keyboard map | button | `?` |
| Close dialog | — | `Esc` |

Settings: window ordering (convex/faithful), gesture cycle on/off and hold time, render scale and
adaptive quality, debug landmarks, HUD tint (auto/white/red), reduced motion (also honours
`prefers-reduced-motion`).

## Development

Requirements: Node `^20.19.0 || >=22.12.0` (Vite 8 / ESLint 10 engine ranges), npm 10.

```bash
npm ci                 # installs deps; postinstall copies the MediaPipe wasm into public/wasm
npm run dev            # predev fetches models into public/models, then Vite on :5173
npm run typecheck      # strict TS
npm run lint           # ESLint flat config
npm test               # Vitest unit suites (incl. repo hygiene / infra checks)
npm run fixture        # generates tests/fixtures/hands.y4m (~125 MB, gitignored) + schedule JSON
npm run test:e2e       # Playwright (Chromium, fake camera fed by the fixture, mock tracking)
npm run build          # tsc + vite build; postbuild verifies dist has models, wasm, no inline scripts
npm run preview        # serve dist on :4173
```

Models (`*.task`, `*.tflite`) and wasm are **not committed**; `prebuild`/`predev`/`postinstall`
regenerate them so a clean `npm ci && npm run build` yields a complete `dist/`.

Project layout, module contracts and ownership: `docs/architecture.md`, `src/OWNERS.md`,
`src/types/**`. Testing strategy: `docs/testing.md`. Security model: `docs/security.md`.
Release checklist: `docs/release.md`.

## Browser support

Chromium-based browsers and Safari 17+ on desktop and mobile (WebGL2, `getUserMedia`,
`MediaRecorder`). Firefox works with a `requestAnimationFrame` fallback for frame callbacks;
MP4 recording is only offered where the browser supports it (WebM otherwise).

## Licences

Code: MIT (see `LICENSE`). Third-party components — MediaPipe (Apache-2.0), Inter (OFL-1.1),
React / zustand / Vite (MIT) — are listed with sources in `NOTICE.md`.
