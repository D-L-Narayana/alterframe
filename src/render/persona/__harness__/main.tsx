/*
 * Dev harness for the persona layer (W6). Not wired into the app.
 * Run: npx vite --port 6216 --open /src/render/persona/__harness__/index.html
 * URL params: ?persona=masked&roll=20&blink=0.3&mouth=0.4&animate=0&reduced=1&landmarks=1&t=1200
 */
import type { FaceTrack, PersonaId, SceneState, TrackingFrame, Vec3 } from '../../../types';
import { FACE_LM } from '../../../types';
import { createPersonaLayer, FACE_OVAL_INDICES, LEFT_EYE_RING, RIGHT_EYE_RING, LIPS_OUTER_RING } from '../index';

const W = 1280, H = 720;
const size = { width: W, height: H };

interface Pose { cx: number; cy: number; rx: number; ry: number; roll: number; eyeOpen: number; mouthOpen: number }

/** Synthetic frontal face (mirrors tests/unit/persona/fixtures.ts) — 478 landmarks on an ellipse. */
function synthFace(p: Pose): FaceTrack {
  const { cx, cy, rx, ry, roll, eyeOpen, mouthOpen } = p;
  const rot = (x: number, y: number): Vec3 => {
    // rotate in a square-ish metric: scale y by aspect so the rotation is visually rigid
    const asp = W / H;
    const dx = x - cx, dy = (y - cy) / asp;
    const rxr = dx * Math.cos(roll) - dy * Math.sin(roll), ryr = dx * Math.sin(roll) + dy * Math.cos(roll);
    return { x: cx + rxr, y: cy + ryr * asp, z: 0 };
  };
  const lm: Vec3[] = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  const put = (i: number, x: number, y: number) => { lm[i] = rot(x, y); };
  const ew = rx * 0.5, eh = ry * 0.14 * Math.max(0.04, eyeOpen);
  const eyeL = { x: cx - rx * 0.45, y: cy - ry * 0.15 }, eyeR = { x: cx + rx * 0.45, y: cy - ry * 0.15 };
  put(FACE_LM.RIGHT_EYE_OUTER, eyeL.x - ew / 2, eyeL.y); put(FACE_LM.RIGHT_EYE_INNER, eyeL.x + ew / 2, eyeL.y);
  put(FACE_LM.RIGHT_EYE_TOP, eyeL.x, eyeL.y - eh / 2); put(FACE_LM.RIGHT_EYE_BOTTOM, eyeL.x, eyeL.y + eh / 2);
  put(FACE_LM.RIGHT_IRIS_CENTER, eyeL.x, eyeL.y);
  put(FACE_LM.LEFT_EYE_OUTER, eyeR.x + ew / 2, eyeR.y); put(FACE_LM.LEFT_EYE_INNER, eyeR.x - ew / 2, eyeR.y);
  put(FACE_LM.LEFT_EYE_TOP, eyeR.x, eyeR.y - eh / 2); put(FACE_LM.LEFT_EYE_BOTTOM, eyeR.x, eyeR.y + eh / 2);
  put(FACE_LM.LEFT_IRIS_CENTER, eyeR.x, eyeR.y);
  RIGHT_EYE_RING.forEach((i, k) => { const a = (k / 16) * Math.PI * 2; put(i, eyeL.x + Math.cos(a) * ew / 2, eyeL.y + Math.sin(a) * eh / 2); });
  LEFT_EYE_RING.forEach((i, k) => { const a = (k / 16) * Math.PI * 2; put(i, eyeR.x + Math.cos(a) * ew / 2, eyeR.y + Math.sin(a) * eh / 2); });
  const my = cy + ry * 0.5, mw = rx * 0.6, mh = ry * 0.07 + mouthOpen * ry * 0.3;
  put(FACE_LM.MOUTH_LEFT, cx - mw / 2, my); put(FACE_LM.MOUTH_RIGHT, cx + mw / 2, my);
  put(FACE_LM.UPPER_LIP, cx, my - mh / 2); put(FACE_LM.LOWER_LIP, cx, my + mh / 2);
  LIPS_OUTER_RING.forEach((i, k) => { const a = (k / 20) * Math.PI * 2; put(i, cx + Math.cos(a) * mw / 2, my + Math.sin(a) * mh / 2); });
  put(FACE_LM.LEFT_CHEEK, cx + rx * 0.55, cy + ry * 0.18); put(FACE_LM.RIGHT_CHEEK, cx - rx * 0.55, cy + ry * 0.18);
  put(FACE_LM.CHIN, cx, cy + ry); put(FACE_LM.FOREHEAD, cx, cy - ry); put(FACE_LM.NOSE_TIP, cx, cy + ry * 0.12);
  FACE_OVAL_INDICES.forEach((i, k) => { const a = -Math.PI / 2 + (k / 36) * Math.PI * 2; put(i, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); });
  const g = (i: number) => ({ x: lm[i]!.x, y: lm[i]!.y });
  return {
    landmarks: lm, blendshapes: {}, transform: null,
    leftEye: g(FACE_LM.RIGHT_IRIS_CENTER), rightEye: g(FACE_LM.LEFT_IRIS_CENTER),
    noseTip: g(FACE_LM.NOSE_TIP), chin: g(FACE_LM.CHIN), forehead: g(FACE_LM.FOREHEAD),
    faceBox: { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 },
    roll, eyeOpenLeft: eyeOpen, eyeOpenRight: eyeOpen, mouthOpen, smile: 0,
  };
}

/** Draws a flat "person" so overlay alignment can be judged: skin head, hair, hood, eyes, mouth. */
function drawSyntheticPerson(ctx: CanvasRenderingContext2D, face: FaceTrack): void {
  const px = (v: { x: number; y: number }) => ({ x: v.x * W, y: v.y * H });
  const c = px({ x: face.faceBox.x + face.faceBox.w / 2, y: face.faceBox.y + face.faceBox.h / 2 });
  const rx = (face.faceBox.w / 2) * W, ry = (face.faceBox.h / 2) * H;
  // body
  ctx.fillStyle = '#6b6f7a';
  ctx.beginPath(); ctx.ellipse(c.x, c.y + ry * 2.6, rx * 2.6, ry * 1.9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e4b79a';
  ctx.fillRect(c.x - rx * 0.35, c.y + ry * 0.8, rx * 0.7, ry * 0.6); // neck
  // hair/hood behind the head
  ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(face.roll * (H / W) + face.roll * (1 - H / W)); ctx.translate(-c.x, -c.y);
  ctx.fillStyle = '#17141a';
  ctx.beginPath(); ctx.ellipse(c.x, c.y - ry * 0.05, rx * 1.25, ry * 1.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // face oval from landmarks
  const oval = FACE_OVAL_INDICES.map((i) => px(face.landmarks[i]!));
  ctx.fillStyle = '#f0c6a8';
  ctx.beginPath(); oval.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
  // eyes
  for (const ring of [RIGHT_EYE_RING, LEFT_EYE_RING]) {
    const pts = ring.map((i) => px(face.landmarks[i]!));
    ctx.fillStyle = '#fff'; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    ctx.fillStyle = '#2a1a10'; ctx.beginPath(); ctx.arc(cx, cy, rx * 0.07, 0, Math.PI * 2); ctx.fill();
  }
  // mouth
  const lips = LIPS_OUTER_RING.map((i) => px(face.landmarks[i]!));
  ctx.fillStyle = '#a0463e'; ctx.beginPath(); lips.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
}

function drawLandmarks(ctx: CanvasRenderingContext2D, face: FaceTrack): void {
  ctx.fillStyle = '#3b7bff';
  for (const i of [...FACE_OVAL_INDICES, ...LEFT_EYE_RING, ...RIGHT_EYE_RING, ...LIPS_OUTER_RING, FACE_LM.LEFT_CHEEK, FACE_LM.RIGHT_CHEEK]) {
    const p = face.landmarks[i]!;
    ctx.fillRect(p.x * W - 1.5, p.y * H - 1.5, 3, 3);
  }
}

function drawChecker(ctx: CanvasRenderingContext2D): void {
  for (let y = 0; y < H; y += 32) for (let x = 0; x < W; x += 32) {
    ctx.fillStyle = ((x + y) / 32) % 2 ? '#2a2a2e' : '#3a3a40'; ctx.fillRect(x, y, 32, 32);
  }
}

// ───────────────────────────── wiring ─────────────────────────────
const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const personaSel = $<HTMLSelectElement>('persona');
const animateCb = $<HTMLInputElement>('animate');
const blinkCb = $<HTMLInputElement>('blink');
const reducedCb = $<HTMLInputElement>('reduced');
const landmarksCb = $<HTMLInputElement>('landmarks');
const rollInput = $<HTMLInputElement>('roll');
const rollV = $<HTMLSpanElement>('rollv');
const stats = $<HTMLSpanElement>('stats');

if (q.get('persona')) personaSel.value = q.get('persona')!;
if (q.get('animate') === '0') animateCb.checked = false;
if (q.get('blink') !== null) blinkCb.checked = false;
if (q.get('reduced') === '1') reducedCb.checked = true;
if (q.get('landmarks') === '1') landmarksCb.checked = true;
if (q.get('roll')) rollInput.value = q.get('roll')!;
const fixedT = q.get('t') ? Number(q.get('t')) : null;

const composite = $<HTMLCanvasElement>('composite').getContext('2d')!;
const overlayView = $<HTMLCanvasElement>('overlayView').getContext('2d')!;
const backdropView = $<HTMLCanvasElement>('backdropView').getContext('2d')!;
const videoView = $<HTMLCanvasElement>('videoView').getContext('2d')!;

const layer = createPersonaLayer({ reducedMotion: reducedCb.checked });
layer.resize(size);
reducedCb.addEventListener('change', () => layer.setReducedMotion(reducedCb.checked));

let repaints = 0, frames = 0;
const t0 = performance.now();

function frame(now: number): void {
  const t = fixedT ?? now - t0;
  const animate = animateCb.checked && fixedT === null;
  const rollDeg = animate ? Math.sin(t / 1400) * 28 : Number(rollInput.value);
  if (animate) { rollInput.value = String(Math.round(rollDeg)); }
  rollV.textContent = `${Math.round(rollDeg)}°`;
  const blinkPhase = (t % 3200) / 3200;
  const eyeOpen = q.get('blink') !== null ? Number(q.get('blink')) : blinkCb.checked ? (blinkPhase > 0.9 ? Math.abs(Math.cos((blinkPhase - 0.9) / 0.1 * Math.PI)) : 1) : 1;
  const mouthOpen = q.get('mouth') !== null ? Number(q.get('mouth')) : animate ? (Math.sin(t / 900) + 1) * 0.25 : 0;
  const face = synthFace({ cx: 0.5 + (animate ? Math.sin(t / 2300) * 0.04 : 0), cy: 0.34, rx: 0.085, ry: 0.19, roll: (rollDeg * Math.PI) / 180, eyeOpen, mouthOpen });
  const tf: TrackingFrame = { t, sourceWidth: W, sourceHeight: H, hands: [], face, segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } };
  const scene: SceneState = { base: 'live', persona: personaSel.value as PersonaId, hudTint: 'white' };

  const before = { o: layer.overlay.__dirty, b: layer.backdrop.__dirty };
  layer.update(tf, scene, t);
  if (layer.overlay.__dirty && !before.o) repaints++;
  frames++;

  const ov = layer.overlay as unknown as CanvasImageSource, bd = layer.backdrop as unknown as CanvasImageSource;
  // composite: backdrop → person → overlay (the real app stylises the video and keys the background by segmentation)
  composite.drawImage(bd, 0, 0);
  drawSyntheticPerson(composite, face);
  composite.drawImage(ov, 0, 0);
  if (landmarksCb.checked) drawLandmarks(composite, face);
  // overlay only
  drawChecker(overlayView); overlayView.drawImage(ov, 0, 0);
  if (landmarksCb.checked) drawLandmarks(overlayView, face);
  // backdrop only
  backdropView.drawImage(bd, 0, 0);
  // video only
  videoView.fillStyle = '#c9c4bb'; videoView.fillRect(0, 0, W, H); drawSyntheticPerson(videoView, face);

  layer.overlay.__dirty = false; layer.backdrop.__dirty = false;
  if (frames % 30 === 0) stats.textContent = `frames ${frames} · overlay repaints ${repaints}`;
  (window as unknown as { __personaHarness: unknown }).__personaHarness = { frames, repaints, persona: scene.persona, bench };
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Micro-benchmark: force N overlay repaints (changing roll) and report ms per update. */
function bench(persona: PersonaId, n = 60): { overlayMsPerUpdate: number; backdropMsPerPaint: number } {
  const l = createPersonaLayer({ reducedMotion: false });
  l.resize(size);
  const scene: SceneState = { base: 'live', persona, hudTint: 'white' };
  const mk = (i: number): TrackingFrame => ({ t: i * 16, sourceWidth: W, sourceHeight: H, hands: [], face: synthFace({ cx: 0.5, cy: 0.42, rx: 0.085, ry: 0.19, roll: (i / n) * 0.6 - 0.3, eyeOpen: 1, mouthOpen: 0 }), segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } });
  l.update(mk(0), scene, 0); // warm-up paints both
  const t0 = performance.now();
  for (let i = 1; i <= n; i++) l.update(mk(i), scene, 0); // t fixed → backdrop static, overlay repaints
  const overlayMs = (performance.now() - t0) / n;
  const t1 = performance.now();
  for (let i = 1; i <= n; i++) l.update(mk(0), scene, i * 40); // overlay static, backdrop ticks (masked only)
  const backdropMs = (performance.now() - t1) / n;
  return { overlayMsPerUpdate: overlayMs, backdropMsPerPaint: backdropMs };
}
