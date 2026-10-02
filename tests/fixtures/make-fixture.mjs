#!/usr/bin/env node
/**
 * Synthetic fake-camera fixture generator (owner: W10). No dependencies, no real footage.
 *
 * Produces:
 *   tests/fixtures/hands.y4m           640×360, 30 fps, 12 s, I420 (≈125 MB, GITIGNORED, regenerated on demand)
 *   tests/fixtures/hands.schedule.json expected hand tips / face anchors per 0.5 s (small, committed)
 *
 * Scene: neutral grey background, an ellipse "head" with two dark "eyes" and a mouth,
 * two hand-like shapes (palm disc + index bar pointing up + thumb bar pointing inward) that
 * move on this schedule (seconds):
 *   0–2   together (palms touching, low)        → no window
 *   2–8   apart, L pose, LEFT hand higher        → tall skewed window
 *   8–10  together                               → window collapses (gesture arm)
 *   10–12 apart, same height, wide               → wide window (gesture → cycle persona)
 *
 * Coordinates in the schedule are NORMALIZED DISPLAY SPACE (src/types/geometry.ts): x,y∈[0,1],
 * origin top-left, AFTER mirroring. The camera image is the mirror of display space, so this
 * generator draws every shape at camera x = 1 − displayX. "left" always means screen-left.
 *
 * Usage: node tests/fixtures/make-fixture.mjs [--if-missing] [--frames N] [--out file.y4m] [--schedule-only]
 */
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE = Object.freeze({
  width: 640,
  height: 360,
  fps: 30,
  durationS: 12,
  /** Sample spacing of hands.schedule.json in seconds. */
  sampleStepS: 0.5,
  /** Duration of the blend between two poses (seconds). */
  transitionS: 0.4,
});

/** Phase table: [startS, endS, name]. Used by tests to know what the fixture should show. */
export const PHASES = Object.freeze([
  { start: 0, end: 2, name: 'together', together: true },
  { start: 2, end: 8, name: 'apart-skewed', together: false },
  { start: 8, end: 10, name: 'together', together: true },
  { start: 10, end: 12, name: 'apart-wide', together: false },
]);

/** Static clip for visual baselines: 1 s of the skewed pose (t = 5 s). Chromium loops it. */
export const STILL = Object.freeze({ frame: 150, frames: 30 });

/** Static face: slightly above centre so the hands (lower) do not occlude it. */
export const FACE = Object.freeze({
  center: { x: 0.5, y: 0.36 },
  rx: 0.085, // half-width (normalized by width)
  ry: 0.2, // half-height (normalized by height)
  leftEye: { x: 0.465, y: 0.33 },
  rightEye: { x: 0.535, y: 0.33 },
  eyeR: 0.012,
  mouth: { x: 0.5, y: 0.43, w: 0.04, h: 0.012 },
});

const HAND = Object.freeze({
  palmR: 0.045, // palm radius normalized by height
  indexLen: 0.17, // palm centre → index tip (up), normalized by height
  thumbLen: 0.085, // palm centre → thumb tip (inward), normalized by width
  barW: 0.016, // finger bar thickness (normalized by height)
});

/** Key poses (display space). Left hand = screen-left. */
const POSES = Object.freeze({
  // Palms 0.044 apart (< togetherDistance 0.12) and the tip quad area ≈ 0.0075 (< openArea/2 = 0.01),
  // so the pose counts as "together" for W7's gesture detector even though the tips still form a slit.
  // Thumbs are tucked (thumb = 0.02) so the tips collapse to a ≈0.004 sliver, as pressed-together hands do.
  together: {
    left: { x: 0.478, y: 0.76 },
    right: { x: 0.522, y: 0.76 },
    thumb: 0.02,
  },
  apartSkewed: {
    left: { x: 0.24, y: 0.5 },
    right: { x: 0.74, y: 0.66 },
    thumb: HAND.thumbLen,
  },
  apartWide: {
    left: { x: 0.17, y: 0.62 },
    right: { x: 0.83, y: 0.62 },
    thumb: HAND.thumbLen,
  },
});

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => a + (b - a) * u;
const lerpPt = (a, b, u) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) });

/** Pose keyframes with the time at which each one is fully reached. */
const KEYFRAMES = [
  { t: 0, pose: POSES.together },
  { t: 2, pose: POSES.apartSkewed },
  { t: 8, pose: POSES.together },
  { t: 10, pose: POSES.apartWide },
  { t: 12, pose: POSES.apartWide },
];

/**
 * Palm centres at time t (seconds). Blends between keyframes over FIXTURE.transitionS
 * starting at each keyframe time so the hands never teleport.
 */
export function palmsAt(t) {
  let cur = KEYFRAMES[0];
  let next = null;
  for (let i = 0; i < KEYFRAMES.length; i++) {
    const k = KEYFRAMES[i];
    if (t >= k.t) {
      cur = k;
      next = KEYFRAMES[i + 1] ?? null;
    }
  }
  if (!next) return { left: { ...cur.pose.left }, right: { ...cur.pose.right }, thumb: cur.pose.thumb };
  const u = smooth(clamp01((t - next.t + FIXTURE.transitionS) / FIXTURE.transitionS));
  // Before next.t − transitionS: fully `cur`; at next.t: fully `next`.
  return {
    left: lerpPt(cur.pose.left, next.pose.left, u),
    right: lerpPt(cur.pose.right, next.pose.right, u),
    thumb: lerp(cur.pose.thumb, next.pose.thumb, u),
  };
}

/** Derived tips for one hand. `inward` is +1 for the screen-left hand, −1 for the screen-right hand. */
export function handFromPalm(palm, inward, thumbLen = HAND.thumbLen) {
  return {
    palmCenter: { x: palm.x, y: palm.y },
    indexTip: { x: palm.x, y: palm.y - HAND.indexLen },
    thumbTip: { x: palm.x + inward * thumbLen, y: palm.y },
  };
}

export function phaseAt(t) {
  const p = PHASES.find((ph) => t >= ph.start && t < ph.end) ?? PHASES[PHASES.length - 1];
  return p;
}

/** Full schedule sample at time t (display space). */
export function scheduleAt(t) {
  const { left, right, thumb } = palmsAt(t);
  const phase = phaseAt(t);
  const L = handFromPalm(left, +1, thumb);
  const R = handFromPalm(right, -1, thumb);
  const palmDist = Math.hypot(L.palmCenter.x - R.palmCenter.x, L.palmCenter.y - R.palmCenter.y);
  // Area of the simple (convex-ordered) tip quad [L.index, R.index, R.thumb, L.thumb] — the window W7 derives.
  const q = [L.indexTip, R.indexTip, R.thumbTip, L.thumbTip];
  let twiceArea = 0;
  for (let i = 0; i < 4; i++) twiceArea += q[i].x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * q[i].y;
  const tipArea = Math.abs(twiceArea) / 2;
  return {
    t: Number(t.toFixed(3)),
    phase: phase.name,
    // W7 semantics (DEFAULT_INTERACTION_SETTINGS): palms within togetherDistance AND tip area < openArea/2.
    together: palmDist < 0.12 && tipArea < 0.01,
    palmDistance: Number(palmDist.toFixed(4)),
    tipArea: Number(tipArea.toFixed(5)),
    hands: [
      { side: 'left', ...L },
      { side: 'right', ...R },
    ],
    face: {
      center: FACE.center,
      leftEye: FACE.leftEye,
      rightEye: FACE.rightEye,
      box: { x: FACE.center.x - FACE.rx, y: FACE.center.y - FACE.ry, w: FACE.rx * 2, h: FACE.ry * 2 },
    },
  };
}

export function buildSchedule() {
  const samples = [];
  for (let t = 0; t <= FIXTURE.durationS + 1e-9; t += FIXTURE.sampleStepS) samples.push(scheduleAt(Number(t.toFixed(3))));
  return {
    meta: {
      generator: 'tests/fixtures/make-fixture.mjs',
      coordinateSpace: 'normalized display space, origin top-left, mirrored (camera x = 1 - x)',
      width: FIXTURE.width,
      height: FIXTURE.height,
      fps: FIXTURE.fps,
      durationS: FIXTURE.durationS,
      sampleStepS: FIXTURE.sampleStepS,
      togetherDistance: 0.12,
    },
    phases: PHASES,
    samples,
  };
}

// ---------------------------------------------------------------------------------------------
// Rasterizer: writes a colour-index map then converts to I420 with a tiny palette LUT.
// ---------------------------------------------------------------------------------------------

/** Palette indices → RGB. Kept distinct in luma so face/hand detectors have something to chew on. */
const PALETTE = [
  [168, 172, 178], // 0 background: neutral grey
  [214, 176, 150], // 1 skin (head + hands)
  [40, 34, 36], // 2 eyes / hair
  [150, 60, 70], // 3 mouth
  [52, 56, 90], // 4 torso/shirt
  [238, 232, 220], // 5 finger highlight (slightly lighter skin edge)
];

function rgbToYuv([r, g, b]) {
  // BT.601 limited range, matching what Chromium expects from a C420jpeg-tagged file closely enough.
  const y = Math.round(16 + 0.257 * r + 0.504 * g + 0.098 * b);
  const u = Math.round(128 - 0.148 * r - 0.291 * g + 0.439 * b);
  const v = Math.round(128 + 0.439 * r - 0.368 * g - 0.071 * b);
  return [clampByte(y), clampByte(u), clampByte(v)];
}
const clampByte = (v) => Math.max(0, Math.min(255, v));
const LUT = PALETTE.map(rgbToYuv);

function fillEllipse(idx, W, H, cx, cy, rx, ry, color) {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      if (dx * dx + dy * dy <= 1) idx[y * W + x] = color;
    }
  }
}

function fillRect(idx, W, H, x, y, w, h, color) {
  const x0 = Math.max(0, Math.floor(Math.min(x, x + w)));
  const x1 = Math.min(W - 1, Math.ceil(Math.max(x, x + w)));
  const y0 = Math.max(0, Math.floor(Math.min(y, y + h)));
  const y1 = Math.min(H - 1, Math.ceil(Math.max(y, y + h)));
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) idx[yy * W + xx] = color;
}

/** Display-space → camera pixel coordinates (mirror on x). */
function toCam(p, W, H) {
  return { x: (1 - p.x) * W, y: p.y * H };
}

/** Draws frame `i` into an I420 buffer. Exported for tests (they check a few pixels). */
export function renderFrame(i, W = FIXTURE.width, H = FIXTURE.height) {
  const t = i / FIXTURE.fps;
  const s = scheduleAt(t);
  const idx = new Uint8Array(W * H); // palette index per pixel, 0 = background

  // Torso: a wide rounded block under the head so segmentation has a "person" region.
  const head = toCam(FACE.center, W, H);
  fillEllipse(idx, W, H, head.x, head.y + FACE.ry * H * 1.9, FACE.rx * W * 2.6, FACE.ry * H * 1.4, 4);
  // Head.
  fillEllipse(idx, W, H, head.x, head.y, FACE.rx * W, FACE.ry * H, 1);
  // Hair cap.
  fillEllipse(idx, W, H, head.x, head.y - FACE.ry * H * 0.72, FACE.rx * W * 1.02, FACE.ry * H * 0.36, 2);
  // Eyes (mirror: FACE.leftEye is screen-left, i.e. camera-right).
  for (const eye of [FACE.leftEye, FACE.rightEye]) {
    const e = toCam(eye, W, H);
    fillEllipse(idx, W, H, e.x, e.y, FACE.eyeR * W * 1.6, FACE.eyeR * H * 1.6, 5);
    fillEllipse(idx, W, H, e.x, e.y, FACE.eyeR * W, FACE.eyeR * H, 2);
  }
  // Mouth.
  const m = toCam(FACE.mouth, W, H);
  fillEllipse(idx, W, H, m.x, m.y, FACE.mouth.w * W, FACE.mouth.h * H, 3);

  // Hands: palm disc, index bar up, thumb bar inward, small highlight at the tips.
  for (const hand of s.hands) {
    const palm = toCam(hand.palmCenter, W, H);
    const index = toCam(hand.indexTip, W, H);
    const thumb = toCam(hand.thumbTip, W, H);
    const bw = HAND.barW * H;
    const pr = HAND.palmR * H;
    fillEllipse(idx, W, H, palm.x, palm.y, pr, pr, 1);
    fillRect(idx, W, H, index.x - bw / 2, index.y, bw, palm.y - index.y, 1);
    fillRect(idx, W, H, Math.min(palm.x, thumb.x), thumb.y - bw / 2, Math.abs(palm.x - thumb.x), bw, 1);
    // Folded fingers: three short bars on the outer side of the palm.
    const outward = palm.x > W / 2 ? 1 : -1; // camera-space outward direction
    for (let f = 0; f < 3; f++) {
      fillRect(idx, W, H, palm.x + outward * pr * 0.2, palm.y - pr * 0.8 + f * pr * 0.55, outward * pr * 0.9, bw * 0.7, 1);
    }
    fillEllipse(idx, W, H, index.x, index.y, bw * 0.55, bw * 0.55, 5);
    fillEllipse(idx, W, H, thumb.x, thumb.y, bw * 0.55, bw * 0.55, 5);
  }

  // Convert palette map → I420 planes.
  const Y = new Uint8Array(W * H);
  const U = new Uint8Array((W / 2) * (H / 2));
  const V = new Uint8Array((W / 2) * (H / 2));
  for (let p = 0; p < W * H; p++) Y[p] = LUT[idx[p]][0];
  for (let cy = 0; cy < H / 2; cy++) {
    for (let cx = 0; cx < W / 2; cx++) {
      // Average the 2×2 block's chroma (palette-index majority is fine; average keeps edges soft).
      const a = idx[(cy * 2) * W + cx * 2];
      const b = idx[(cy * 2) * W + cx * 2 + 1];
      const c = idx[(cy * 2 + 1) * W + cx * 2];
      const d = idx[(cy * 2 + 1) * W + cx * 2 + 1];
      U[cy * (W / 2) + cx] = (LUT[a][1] + LUT[b][1] + LUT[c][1] + LUT[d][1]) >> 2;
      V[cy * (W / 2) + cx] = (LUT[a][2] + LUT[b][2] + LUT[c][2] + LUT[d][2]) >> 2;
    }
  }
  return { Y, U, V, idx, width: W, height: H, t, sample: s };
}

export function y4mHeader(W = FIXTURE.width, H = FIXTURE.height, fps = FIXTURE.fps) {
  return `YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`;
}

/**
 * @param opts.frames   number of frames to write
 * @param opts.stillFrame when set, every output frame is this source frame index (static clip for
 *                       deterministic visual baselines; Chromium loops the file)
 */
export async function writeY4m(outPath, { frames = FIXTURE.fps * FIXTURE.durationS, stillFrame = null, log = () => {} } = {}) {
  mkdirSync(dirname(outPath), { recursive: true });
  const ws = createWriteStream(outPath);
  const write = (chunk) => new Promise((res, rej) => ws.write(chunk, (e) => (e ? rej(e) : res())));
  await write(y4mHeader());
  const FRAME = Buffer.from('FRAME\n');
  const still = stillFrame === null ? null : renderFrame(stillFrame);
  for (let i = 0; i < frames; i++) {
    const { Y, U, V } = still ?? renderFrame(i);
    await write(Buffer.concat([FRAME, Buffer.from(Y.buffer), Buffer.from(U.buffer), Buffer.from(V.buffer)]));
    if (i % 60 === 0) log(`[fixture] frame ${i}/${frames}`);
  }
  await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
  return statSync(outPath).size;
}

export function writeSchedule(outPath) {
  const schedule = buildSchedule();
  writeFileSync(outPath, JSON.stringify(schedule, null, 2) + '\n');
  return schedule;
}

function parseArgs(argv) {
  const args = { ifMissing: false, frames: FIXTURE.fps * FIXTURE.durationS, out: null, scheduleOnly: false, still: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--if-missing') args.ifMissing = true;
    else if (a === '--still') args.still = true;
    else if (a === '--schedule-only') args.scheduleOnly = true;
    else if (a === '--frames') args.frames = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = parseArgs(process.argv.slice(2));
  const schedulePath = resolve(here, 'hands.schedule.json');
  writeSchedule(schedulePath);
  console.log(`[fixture] wrote ${schedulePath}`);
  if (args.scheduleOnly) return;
  const jobs = args.still
    ? [{ path: args.out ? resolve(args.out) : resolve(here, 'hands-still.y4m'), frames: STILL.frames, stillFrame: STILL.frame }]
    : args.out
      ? [{ path: resolve(args.out), frames: args.frames, stillFrame: null }]
      : [
          { path: resolve(here, 'hands.y4m'), frames: args.frames, stillFrame: null },
          { path: resolve(here, 'hands-still.y4m'), frames: STILL.frames, stillFrame: STILL.frame },
        ];
  for (const job of jobs) {
    const expectedBytes = y4mHeader().length + job.frames * (6 + FIXTURE.width * FIXTURE.height * 1.5);
    if (args.ifMissing && existsSync(job.path) && statSync(job.path).size === expectedBytes) {
      console.log(`[fixture] ok ${job.path} (${(expectedBytes / 1e6).toFixed(1)} MB)`);
      continue;
    }
    const t0 = Date.now();
    const bytes = await writeY4m(job.path, { frames: job.frames, stillFrame: job.stillFrame, log: (m) => process.stdout.write(m + '\r') });
    console.log(`\n[fixture] wrote ${job.path} ${(bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (bytes !== expectedBytes) throw new Error(`[fixture] size mismatch: ${bytes} != ${expectedBytes}`);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
