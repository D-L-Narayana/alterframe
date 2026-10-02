# Architecture

AlterFrame is a single-page Vite + React 19 app with a per-frame runtime loop that feeds raw
WebGL2. There is no backend; models and wasm are static files served from the same origin.

```
┌─ React UI (W1) ───────────────────────────────────────────────┐
│ Onboarding/permission → Stage (canvas) → Controls → Settings   │
│ zustand store: settings / scene / session (memory only)        │
└───────────────┬────────────────────────────────────────────────┘
                │ startRuntime(deps)        (W2 runtime loop, per video frame)
                ▼
 FrameSource (W2) ──video──▶ Tracker (W3: hands, face, segmentation) ──TrackingFrame──▶
   Interaction (W7: WindowQuad, gesture events, Director) ──quad/scene──▶
   PersonaLayer (W6: overlay + backdrop 2D canvases) ─┐
   Hud (W8: 2D canvas) ───────────────────────────────┼──▶ Renderer (W4 WebGL2 compositor)
   StylePresets (W5: GLSL passes 'paper-portrait', 'comic') ─┘        │
                                                                     ▼
                                           composited <canvas> ──▶ Recorder / Snapshot (W9)
                                                        PerfMonitor + AdaptiveQuality (W9) → store.quality
 Tests / CI / Vercel / docs / licences (W10)
```

## Per-frame pipeline

1. `FrameSource.onFrame` (requestVideoFrameCallback, rAF fallback) fires with the video time.
2. `Tracker.update(video, t)` → `TrackingFrame` (0–2 hands with 21 landmarks each, face with 478
   landmarks + blendshapes, 256×256 person-confidence mask). Landmarks are One-Euro smoothed and
   already mirrored into **normalized display space** (`src/types/geometry.ts`): x,y ∈ [0,1],
   origin top-left, screen-left ≈ 0.
3. `Interaction.update` → `WindowQuad` (TL,TR,BR,BL from index/thumb tips, hold/fade opacity,
   thickness, area) + events (`window-open/close`, optional `cycle-persona`).
4. `Director.update(t)` (when running) overrides the scene.
5. `PersonaLayer.update` redraws overlay/backdrop canvases only when inputs change (`__dirty`).
6. `Hud.buildModel` (pure) → `Hud.draw` into its own canvas.
7. `Renderer.render(inputs)`:
   * upload video (UV-flipped when mirrored) and mask textures;
   * **base layer**: live video or `STYLE_PRESETS.comic` passes;
   * **window layer**: persona preset passes with `u_backdrop` = persona backdrop, then the persona
     overlay composited with normal alpha;
   * quad mask drawn as two triangles with `quad.opacity`; optional thin-strip glitch (default off);
   * `out = mix(base, window, quadMask)`; HUD composited last;
   * **one** cover-fit mapping from video-frame space to the CSS canvas (object-fit: cover).
8. `PerfMonitor.sample`; adaptive policy may lower `renderScale` / raise `segmentationStride`.

Overlay canvases (persona, HUD) are sized to the **video frame**, not the CSS canvas, so every
module works in the same normalized space and the renderer applies the single cover-fit mapping.

## Coordinate contract

Normalized display space everywhere between modules. Pixel conversion only at the edges:
`px = x * width`, `py = y * height` where width/height are the video-frame-sized overlay canvas.
Mirroring is applied exactly once (tracker output + renderer video UV flip).

## Module ownership

See `src/OWNERS.md`. Contracts live in `src/types/**` (`CONTRACT_VERSION`). Change requests are
collected in `docs/handoffs/Wn.md` and merged by the lead into `docs/contract-changes.md`.

## Dev-only hooks

The runtime exposes `window.__alterframe` (a `RuntimeHandle`) and `injectTracking(frame)` **only**
when `import.meta.env.DEV` or `import.meta.env.VITE_E2E === '1'`, and only if the page URL has
`?mockTracking=1`. Production builds strip both paths; `tests/e2e/production-gate.spec.ts`
verifies it against a preview of the production bundle.

## Static payload

```
dist/
  index.html                hashed entry (no inline scripts; CSP script-src 'self')
  assets/*.js|css|woff2     content-hashed → Cache-Control immutable
  models/*.task|tflite      fetched by `prebuild` (Apache-2.0, not in Git) → 1-day cache + SWR
  wasm/*.js|wasm            copied by `postinstall` from @mediapipe/tasks-vision → 1-day cache + SWR
  icons/*.svg, favicon.svg, manifest.webmanifest, robots.txt
```
