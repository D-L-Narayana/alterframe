# Dev-only harness pages (owner: W10)

These HTML pages are served by the Vite **dev** server only (`/tests/e2e/pages/*.html`). They are
never part of the production bundle (`vite build` only follows `index.html`). They let the e2e
suite exercise GPU code (W4 renderer, W5 shaders) directly, without the full app being wired.

| Page | Spec | What it proves |
|---|---|---|
| `shaders.html` | `shaders.spec.ts` | every `STYLE_PRESETS` pass compiles on real WebGL2 (via W4 `compilePass` when exported, else raw `compileShader` with the contract prelude) |
| `pixels.html` | `render-pixels.spec.ts` | W4 compositor: solid base + solid window → pixels inside the quad are the window colour, outside the base colour, opacity 0.5 blends; cover-fit maps normalized coords once |

Module imports are dynamic (`import('/src/...')`) with runtime shape checks, so these pages
typecheck even while other workers' modules are still missing.
