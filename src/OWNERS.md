# Module ownership

One owner per path; everyone else may read, never write. Contracts live in `src/types/**` and
change only through the maintainer (`docs/contract-changes.md`); the current version is
`CONTRACT_VERSION` in `src/types/index.ts`. Each module ships with its own unit suite under
`tests/unit/<module>/`; the public API and conventions of every module are described in
`docs/modules.md`.

| Area | Paths | Tests |
|------|-------|-------|
| Contracts and repository configuration (maintainer) | `src/types/**`, `src/OWNERS.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `.npmrc`, `.gitignore`, `.vercelignore`, `index.html`, `docs/contract-changes.md` | — |
| App shell, state and workflows | `src/main.tsx`, `src/app/**`, `src/ui/**`, `src/state/**`, `src/styles/**` | `tests/unit/app/**` |
| Media sources and runtime loop | `src/media/**`, `src/runtime/**` | `tests/unit/media/**` |
| Tracking (MediaPipe wrapper, lazy chunk) | `src/tracking/**`, `public/models/README.md` | `tests/unit/tracking/**` |
| WebGL2 compositor | `src/render/core/**` | `tests/unit/render-core/**` |
| Stylization shaders and presets | `src/render/shaders/**`, `src/render/styles.ts` | `tests/unit/shaders/**` |
| Persona layer | `src/render/persona/**` | `tests/unit/persona/**` |
| Window geometry, gestures, director | `src/interaction/**` | `tests/unit/interaction/**` |
| HUD | `src/hud/**` | `tests/unit/hud/**` |
| Capture and performance | `src/capture/**`, `src/perf/**` | `tests/unit/capture/**`, `tests/unit/perf/**` |
| QA, infrastructure, docs | `tests/e2e/**`, `tests/fixtures/**`, `tests/unit/infra/**`, `tests/unit/repo-hygiene.test.ts`, `.github/**`, `vercel.json`, `scripts/**`, `playwright.config.ts`, `vitest.config.ts`, `eslint.config.js`, `README.md`, `NOTICE.md`, `LICENSE`, `CHANGELOG.md`, `docs/**` (except `contract-changes.md`), `public/**` (except `models/README.md`) | `tests/unit/infra/**`, `tests/e2e/**` |

Dev harness pages (`src/**/__harness__/`) belong to their module, are served by the Vite dev
server only and are never imported by application code.
