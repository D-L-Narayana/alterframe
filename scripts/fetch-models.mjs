// Downloads MediaPipe model files (Apache-2.0, Google) into public/models at build time.
// Models are NOT committed to git (see .gitignore); `prebuild`/`predev` run this so a plain
// `npm ci && npm run build` (locally, in CI, on Vercel) yields a runnable dist with /models.
// Owner: W10 (infra). Builders may run `npm run fetch-models`.
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';

const BASE = process.env.MEDIAPIPE_MODELS_BASE ?? 'https://storage.googleapis.com/mediapipe-models';
export const MODELS = [
  { file: 'hand_landmarker.task', url: `${BASE}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`, minBytes: 7_000_000 },
  { file: 'face_landmarker.task', url: `${BASE}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`, minBytes: 3_000_000 },
  { file: 'selfie_segmenter.tflite', url: `${BASE}/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`, minBytes: 200_000 },
];
const RETRIES = 3;
const dir = resolve(process.cwd(), 'public/models');
mkdirSync(dir, { recursive: true });

async function download(m) {
  const dest = resolve(dir, m.file);
  const tmp = `${dest}.part`;
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(m.url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      const size = statSync(tmp).size;
      if (size < m.minBytes) throw new Error(`too small (${size} B < ${m.minBytes} B)`);
      renameSync(tmp, dest);
      console.log(`[models] fetched ${m.file} (${(size / 1e6).toFixed(2)} MB)`);
      return;
    } catch (e) {
      lastErr = e;
      if (existsSync(tmp)) unlinkSync(tmp);
      console.warn(`[models] ${m.file} attempt ${attempt}/${RETRIES} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`[models] giving up on ${m.file} (${m.url}): ${lastErr?.message}`);
}

for (const m of MODELS) {
  const dest = resolve(dir, m.file);
  if (existsSync(dest) && statSync(dest).size >= m.minBytes) {
    console.log(`[models] ok ${m.file}`);
    continue;
  }
  console.log(`[models] fetching ${m.file}`);
  await download(m);
}
console.log('[models] done');
