# MediaPipe model files (not committed)

The `.task` / `.tflite` files in this folder are downloaded at build time by
`scripts/fetch-models.mjs` (`npm run fetch-models`, also run by `predev` / `prebuild`) and are
gitignored. `vite build` copies them into `dist/models/` so the app serves them **same-origin**
(`/models/...`); nothing is fetched from a CDN at runtime. The WASM runtime is served the same
way from `/wasm/` (copied from `node_modules/@mediapipe/tasks-vision/wasm` by `scripts/copy-wasm.mjs`).

| File | Task | Size | Source URL |
|---|---|---|---|
| `hand_landmarker.task` | HandLandmarker (21 landmarks × 2 hands, handedness) | 7,819,105 B | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task |
| `face_landmarker.task` | FaceLandmarker (478 landmarks, 52 blendshapes, transform matrix) | 3,758,596 B | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task |
| `selfie_segmenter.tflite` | ImageSegmenter (single label `selfie`, 256×256 input, confidence mask) | 249,537 B | https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite |

## Licence

All three models and the `@mediapipe/tasks-vision` runtime are published by Google under the
**Apache License 2.0** (https://www.apache.org/licenses/LICENSE-2.0). Model cards:

- Hand Landmarker: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
- Face Landmarker: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
- Image Segmenter (Selfie segmentation): https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter

Attribution for the shipped bundle lives in `NOTICE.md` (W10). The models are consumed by
`src/tracking/` (W3), which streams them from `/models` with progress reporting and passes them to
MediaPipe as `modelAssetBuffer`.

## Privacy

Inference runs entirely in the browser (WASM + WebGL2). Camera frames never leave the device; the
only network requests are the same-origin model and WASM downloads above.
