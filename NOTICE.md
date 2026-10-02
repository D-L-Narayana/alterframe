# Third-party notices

AlterFrame is licensed under the MIT License (see `LICENSE`). It bundles or downloads the
following third-party components. Their licences and copyright notices are preserved as required;
nothing below may be removed to satisfy a string-hygiene scan.

## Runtime dependencies

| Component | Version | Licence | Copyright / source |
|---|---|---|---|
| MediaPipe Tasks Vision (`@mediapipe/tasks-vision`, wasm runtime copied to `/wasm`) | 1.0.1 | Apache License, Version 2.0 | Copyright Google LLC — https://github.com/google-ai-edge/mediapipe · https://www.npmjs.com/package/@mediapipe/tasks-vision |
| MediaPipe models: `hand_landmarker.task`, `face_landmarker.task`, `selfie_segmenter.tflite` (downloaded at build time into `/models`, not committed) | float16 "latest" | Apache License, Version 2.0 | Copyright Google LLC — https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker · https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker · https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter — files served from https://storage.googleapis.com/mediapipe-models/ |
| Inter typeface (`@fontsource/inter`) | 5.3.0 (Inter 4.x) | SIL Open Font License 1.1 (OFL-1.1) | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) — packaging https://fontsource.org/fonts/inter |
| React, React DOM | 19.3.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates — https://github.com/facebook/react |
| zustand | 5.0.15 | MIT | Copyright (c) 2019 Paul Henschel — https://github.com/pmndrs/zustand |

## Build / test tooling (not shipped)

Vite (MIT, https://github.com/vitejs/vite), TypeScript (Apache-2.0, https://github.com/microsoft/TypeScript),
Vitest (MIT, https://github.com/vitest-dev/vitest), Playwright (Apache-2.0, https://github.com/microsoft/playwright),
axe-core (MPL-2.0, https://github.com/dequelabs/axe-core), ESLint and plugins (MIT).

## Apache License 2.0 — notice

The MediaPipe components are distributed under the Apache License, Version 2.0. A copy of the
licence is available at https://www.apache.org/licenses/LICENSE-2.0. The wasm files under
`public/wasm/` are verbatim copies from the npm package and keep their embedded copyright headers.

## SIL Open Font License 1.1 — notice

Inter is licensed under the SIL Open Font License, Version 1.1, available with a FAQ at
https://openfontlicense.org. The font files are bundled unmodified from `@fontsource/inter`.
The OFL permits bundling with software of any licence; the font itself remains under the OFL.

## Original work

All vector art (persona overlays, backdrops, icons), shaders and UI in this repository are
original and procedural. No third-party footage, music, character names or logos are included.
The project is inspired by a popular style of hand-window webcam effect; it is an independent,
real-time procedural approximation, not a reproduction of any specific video.
