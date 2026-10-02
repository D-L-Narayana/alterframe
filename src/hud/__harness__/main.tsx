/**
 * W8 HUD harness. Standalone page (never imported by the app) that renders sample
 * HUD models over a procedural stand-in for the composited frame, for both tints and
 * several geometric edge cases. Run: `npx vite --port 6218 --open /src/hud/__harness__/index.html`.
 * Everything here is synthetic: no camera, no reference pixels.
 */
import { createHud } from '../index';
import type { HudHandle } from '../index';
import type { FaceTrack, HandTrack, SceneState, TrackingFrame, Vec2, Vec3, WindowQuad } from '@/types';

const SIZE = { width: 1280, height: 720 };

interface Case {
  title: string;
  scene: SceneState;
  quad: (t: number) => WindowQuad | null;
  face: (t: number) => FaceTrack | null;
  hands?: (quad: WindowQuad) => HandTrack[];
}

function vec(x: number, y: number): Vec2 { return { x, y }; }

function makeQuad(c: [Vec2, Vec2, Vec2, Vec2], opacity = 1): WindowQuad {
  // Shoelace area + mean edge length, same definitions W7 uses.
  const [a, b, cc, d] = c;
  const area = Math.abs((a.x * b.y - b.x * a.y) + (b.x * cc.y - cc.x * b.y) + (cc.x * d.y - d.x * cc.y) + (d.x * a.y - a.x * d.y)) / 2;
  const thickness = (Math.hypot(a.x - d.x, a.y - d.y) + Math.hypot(b.x - cc.x, b.y - cc.y)) / 2;
  return { corners: c, opacity, thickness, area, centroid: vec((a.x + b.x + cc.x + d.x) / 4, (a.y + b.y + cc.y + d.y) / 4), visible: true, ordering: 'convex' };
}

function makeFace(center: Vec2, scale: number, mouthOpen: number, roll = 0): FaceTrack {
  const landmarks: Vec3[] = Array.from({ length: 478 }, () => ({ x: center.x, y: center.y, z: 0 }));
  const rot = (p: Vec2): Vec2 => {
    const dx = (p.x - center.x) * (SIZE.width / SIZE.height); const dy = p.y - center.y;
    const c = Math.cos(roll); const s = Math.sin(roll);
    return vec(center.x + (dx * c - dy * s) / (SIZE.width / SIZE.height), center.y + dx * s + dy * c);
  };
  const leftEye = rot(vec(center.x - 0.035 * scale, center.y - 0.03 * scale));
  const rightEye = rot(vec(center.x + 0.035 * scale, center.y - 0.03 * scale));
  const mouthY = center.y + 0.09 * scale;
  landmarks[61] = { ...rot(vec(center.x - 0.03 * scale, mouthY)), z: 0 };
  landmarks[291] = { ...rot(vec(center.x + 0.03 * scale, mouthY)), z: 0 };
  landmarks[13] = { ...rot(vec(center.x, mouthY - 0.01 * scale)), z: 0 };
  landmarks[14] = { ...rot(vec(center.x, mouthY + 0.01 * scale + 0.04 * scale * mouthOpen)), z: 0 };
  const w = 0.16 * scale; const h = 0.3 * scale;
  return {
    landmarks, blendshapes: {}, transform: null, leftEye, rightEye,
    noseTip: rot(vec(center.x, center.y + 0.02 * scale)), chin: rot(vec(center.x, center.y + 0.15 * scale)), forehead: rot(vec(center.x, center.y - 0.13 * scale)),
    faceBox: { x: center.x - w / 2, y: center.y - h / 2, w, h }, roll, eyeOpenLeft: 1, eyeOpenRight: 1, mouthOpen, smile: 0,
  };
}

function handFromCorners(side: 'left' | 'right', indexTip: Vec2, thumbTip: Vec2): HandTrack {
  const palm = vec((indexTip.x + thumbTip.x) / 2 + (side === 'left' ? -0.06 : 0.06), (indexTip.y + thumbTip.y) / 2 + 0.08);
  const landmarks: Vec3[] = Array.from({ length: 21 }, (_, i) => {
    const f = i / 20;
    return { x: palm.x + (indexTip.x - palm.x) * f, y: palm.y + (indexTip.y - palm.y) * f, z: 0 };
  });
  landmarks[8] = { ...indexTip, z: 0 };
  landmarks[4] = { ...thumbTip, z: 0 };
  landmarks[0] = { x: palm.x, y: palm.y + 0.08, z: 0 };
  return { side, landmarks, score: 0.95, indexTip, thumbTip, palmCenter: palm, size: 0.12 };
}

const defaultHands = (q: WindowQuad): HandTrack[] => [
  handFromCorners('left', q.corners[0], q.corners[3]),
  handFromCorners('right', q.corners[1], q.corners[2]),
];

const LIVE: SceneState = { base: 'live', persona: 'portrait', hudTint: 'white' };
const COMIC: SceneState = { base: 'comic', persona: 'masked', hudTint: 'red' };

const CASES: Case[] = [
  {
    title: 'A — live base, white tint: corner + eye-left + eye-right (large window), mouth closed',
    scene: LIVE,
    quad: (t) => makeQuad([vec(0.22, 0.22 + 0.02 * Math.sin(t / 900)), vec(0.78, 0.18), vec(0.80, 0.62), vec(0.20, 0.66)]),
    face: () => makeFace(vec(0.52, 0.42), 1, 0.1),
  },
  {
    title: 'B — comic base, red tint: mouth open → thin box; head rolled 18°',
    scene: COMIC,
    quad: () => makeQuad([vec(0.25, 0.25), vec(0.75, 0.30), vec(0.73, 0.70), vec(0.27, 0.68)]),
    face: () => makeFace(vec(0.5, 0.45), 1.1, 0.7, 0.31),
  },
  {
    title: 'C — thin 3 px slit (errata §4b.1): corner + eye-left only, no eye-right (area < 0.06)',
    scene: LIVE,
    quad: () => makeQuad([vec(0.30, 0.50), vec(0.70, 0.49), vec(0.70, 0.494), vec(0.30, 0.504)]),
    face: () => makeFace(vec(0.5, 0.46), 1, 0),
  },
  {
    title: 'D — right-aligned labels (anchor x > 0.7) and top-edge flip (anchor near y = 0)',
    scene: COMIC,
    quad: () => makeQuad([vec(0.86, 0.01), vec(0.99, 0.02), vec(0.99, 0.40), vec(0.85, 0.42)]),
    face: () => makeFace(vec(0.90, 0.25), 0.7, 0.0),
  },
  {
    title: 'E — fading window (opacity 0.4 from quad) and off-canvas eye anchor (clamped bracket)',
    scene: LIVE,
    quad: () => makeQuad([vec(0.10, 0.30), vec(0.60, 0.30), vec(0.60, 0.80), vec(0.10, 0.80)], 0.4),
    face: () => makeFace(vec(0.04, 0.5), 1, 0),
  },
  {
    title: 'F — window hidden: nothing but record dot / fps badge',
    scene: LIVE,
    quad: () => null,
    face: () => null,
  },
];

const root = document.getElementById('root') as HTMLElement;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const controls = {
  animate: $<HTMLInputElement>('animate'), reduced: $<HTMLInputElement>('reduced'), recording: $<HTMLInputElement>('recording'),
  fps: $<HTMLInputElement>('fps'), debug: $<HTMLInputElement>('debug'), opacity: $<HTMLInputElement>('opacity'), font: $<HTMLSelectElement>('font'),
  status: $<HTMLSpanElement>('status'),
};

interface Panel { hud: HudHandle; stage: HTMLCanvasElement; c: Case }

const panels: Panel[] = CASES.map((c) => {
  const fig = document.createElement('figure');
  const stage = document.createElement('canvas');
  stage.className = 'stage';
  stage.width = SIZE.width; stage.height = SIZE.height;
  const cap = document.createElement('figcaption');
  cap.textContent = c.title;
  fig.append(stage, cap);
  root.append(fig);
  const hud = createHud({ reducedMotion: false, seed: 7 });
  hud.resize(SIZE);
  return { hud, stage, c };
});

/** Procedural stand-in for the composited frame: soft gradient + quad fill + fake face oval. */
function drawBackdrop(ctx: CanvasRenderingContext2D, scene: SceneState, quad: WindowQuad | null, face: FaceTrack | null): void {
  const g = ctx.createLinearGradient(0, 0, 0, SIZE.height);
  if (scene.base === 'comic') { g.addColorStop(0, '#e9c9a0'); g.addColorStop(1, '#b67a4a'); } else { g.addColorStop(0, '#5a6572'); g.addColorStop(1, '#2d3238'); }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE.width, SIZE.height);
  if (face) {
    ctx.fillStyle = scene.base === 'comic' ? '#f1b48f' : '#c89b7b';
    ctx.beginPath();
    ctx.ellipse(face.faceBox.x * SIZE.width + face.faceBox.w * SIZE.width / 2, face.faceBox.y * SIZE.height + face.faceBox.h * SIZE.height / 2,
      face.faceBox.w * SIZE.width / 2, face.faceBox.h * SIZE.height / 2, face.roll, 0, Math.PI * 2);
    ctx.fill();
  }
  if (quad) {
    ctx.save();
    ctx.globalAlpha = quad.opacity;
    ctx.fillStyle = scene.persona === 'portrait' ? '#f6f3ec' : '#0b1230';
    ctx.beginPath();
    quad.corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * SIZE.width, p.y * SIZE.height) : ctx.lineTo(p.x * SIZE.width, p.y * SIZE.height)));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

const start = performance.now();
let frozenT = 0;
let lastT = 0;

function frame(now: number): void {
  const t = controls.animate.checked ? now - start : frozenT;
  if (controls.animate.checked) frozenT = t;
  const fontFamily = controls.font.value;
  for (const { hud, stage, c } of panels) {
    hud.setOptions({
      reducedMotion: controls.reduced.checked,
      debugLandmarks: controls.debug.checked,
      ...(fontFamily ? { fontFamily } : {}),
    });
    const quad = c.quad(t);
    const face = c.face(t);
    const q = quad ? { ...quad, opacity: quad.opacity * Number(controls.opacity.value) } : null;
    const frame: TrackingFrame | null = face || q ? {
      t, sourceWidth: SIZE.width, sourceHeight: SIZE.height,
      hands: q ? (c.hands ?? defaultHands)(q) : [], face, segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 },
    } : null;
    const model = hud.buildModel(frame, q, c.scene, t, { recording: controls.recording.checked, fps: 57.3 + 2 * Math.sin(t / 2000), showFps: controls.fps.checked });
    hud.draw(model);
    const ctx = stage.getContext('2d');
    if (!ctx) continue;
    drawBackdrop(ctx, c.scene, q, face);
    ctx.drawImage(hud.canvas as CanvasImageSource, 0, 0);
  }
  if (now - lastT > 250) {
    const status = panels[0]?.hud.buildModel(null, CASES[0]?.quad(t) ?? null, LIVE, t, { recording: false, fps: null, showFps: false });
    controls.status.textContent = `t=${(t / 1000).toFixed(1)}s  corner code ${status?.callouts[0]?.code ?? '—'}  (prefix re-rolls every 0.8 s)`;
    lastT = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Expose for the screenshot script: freeze time at a given value.
declare global { interface Window { __hudHarness?: { freeze(t: number): void } } }
window.__hudHarness = { freeze(t: number) { controls.animate.checked = false; frozenT = t; } };
