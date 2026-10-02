# File ownership (one owner per path; others may READ, never WRITE)

| Path | Owner |
|------|-------|
| src/types/** (contracts) | Lead only — change requests via `docs/contract-changes.md` |
| src/main.tsx, src/app/**, src/ui/**, src/state/**, src/styles/** | W1 App shell & UI |
| src/media/**, src/runtime/** | W2 Media sources & runtime loop |
| src/tracking/**, public/models/README.md | W3 Tracking |
| src/render/core/** | W4 WebGL2 compositor |
| src/render/shaders/**, src/render/styles.ts | W5 Stylization shaders |
| src/render/persona/** | W6 Persona layer |
| src/interaction/** | W7 Window geometry, gestures, director |
| src/hud/** | W8 HUD |
| src/capture/**, src/perf/** | W9 Capture & performance |
| tests/**, .github/**, vercel.json, README.md, LICENSE, NOTICE.md, docs/**, playwright.config.ts, vitest.config.ts, eslint.config.js, scripts/** | W10 QA, infra, docs |
| package.json, tsconfig.json, vite.config.ts, .npmrc, .gitignore | Lead (W10 may propose edits in docs/contract-changes.md) |
