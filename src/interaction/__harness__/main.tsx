/**
 * W7 dev harness (never imported by the app). Synthetic hands drive the real interaction
 * module; the quad is drawn as a translucent polygon with the debug overlay on top.
 * Run: `npx vite --port 6217` then open /src/interaction/__harness__/index.html
 *
 * Controls: the "Corner spring" slider and the "Hold still" select are bound to the
 * InteractionSettings passed on every update (exactly how the app's Settings sheet drives them).
 */
import { DEFAULT_INTERACTION_SETTINGS, DEFAULT_SCENE, HAND_LM } from '../../types';
import type { HandTrack, InteractionSettings, SceneState, TrackingFrame, Vec2, Vec3 } from '../../types';
import { createDirector, createInteraction, drawLandmarks } from '..';

type Scenario = 'l-pose' | 'thumbs-up' | 'crossed' | 'slit' | 'gesture' | 'lost' | 'dwell';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const canvas = byId<HTMLCanvasElement>('c');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2d context unavailable');
const scenarioEl = byId<HTMLSelectElement>('scenario');
const orderingEl = byId<HTMLSelectElement>('ordering');
const springEl = byId<HTMLInputElement>('spring');
const springOut = byId<HTMLOutputElement>('springOut');
const dwellEl = byId<HTMLSelectElement>('dwell');
const gestureEl = byId<HTMLInputElement>('gesture');
const directorBtn = byId<HTMLButtonElement>('director');
const logEl = byId<HTMLPreElement>('log');

function hand(side: 'left' | 'right', indexTip: Vec2, thumbTip: Vec2, palm: Vec2): HandTrack {
  const landmarks: Vec3[] = [];
  for (let i = 0; i < 21; i++) {
    // Spread the remaining landmarks in a fan so the skeleton is visible.
    const a = (i / 21) * Math.PI;
    landmarks.push({ x: palm.x + Math.cos(a) * 0.03, y: palm.y + Math.sin(a) * 0.04, z: 0 });
  }
  landmarks[HAND_LM.INDEX_TIP] = { ...indexTip, z: 0 };
  landmarks[HAND_LM.THUMB_TIP] = { ...thumbTip, z: 0 };
  landmarks[HAND_LM.WRIST] = { x: palm.x, y: palm.y + 0.08, z: 0 };
  return { side, landmarks, score: 0.97, indexTip, thumbTip, palmCenter: palm, size: 0.12 };
}

/** Builds the synthetic frame for the active scenario at phase time `s` (seconds since scenario start). */
function synthFrame(scenario: Scenario, s: number, t: number): TrackingFrame {
  const wob = Math.sin(s * 1.3) * 0.03;
  let hands: HandTrack[] = [];
  switch (scenario) {
    case 'l-pose':
      hands = [
        hand('left', { x: 0.25 + wob, y: 0.3 }, { x: 0.3 + wob, y: 0.62 }, { x: 0.22 + wob, y: 0.55 }),
        hand('right', { x: 0.75 - wob, y: 0.32 + wob }, { x: 0.7 - wob, y: 0.6 }, { x: 0.78 - wob, y: 0.55 }),
      ];
      break;
    case 'thumbs-up':
      hands = [
        hand('left', { x: 0.3, y: 0.62 }, { x: 0.25 + wob, y: 0.3 }, { x: 0.22, y: 0.55 }),
        hand('right', { x: 0.7, y: 0.6 }, { x: 0.75 - wob, y: 0.32 }, { x: 0.78, y: 0.55 }),
      ];
      break;
    case 'crossed':
      hands = [
        hand('left', { x: 0.2, y: 0.2 + wob }, { x: 0.22, y: 0.8 }, { x: 0.15, y: 0.5 }),
        hand('right', { x: 0.8, y: 0.8 - wob }, { x: 0.78, y: 0.2 }, { x: 0.85, y: 0.5 }),
      ];
      break;
    case 'slit':
      hands = [
        hand('left', { x: 0.38, y: 0.5 }, { x: 0.39, y: 0.512 }, { x: 0.35, y: 0.56 }),
        hand('right', { x: 0.62, y: 0.5 }, { x: 0.61, y: 0.512 }, { x: 0.65, y: 0.56 }),
      ];
      break;
    case 'gesture': {
      // 0–1 s together, 1–3 s open, repeat every 3 s.
      const phase = s % 3;
      if (phase < 1) {
        hands = [
          hand('left', { x: 0.49, y: 0.4 }, { x: 0.49, y: 0.46 }, { x: 0.48, y: 0.5 }),
          hand('right', { x: 0.51, y: 0.4 }, { x: 0.51, y: 0.46 }, { x: 0.52, y: 0.5 }),
        ];
      } else {
        const k = Math.min(1, (phase - 1) * 2);
        hands = [
          hand('left', { x: 0.49 - 0.24 * k, y: 0.4 - 0.1 * k }, { x: 0.49 - 0.2 * k, y: 0.46 + 0.16 * k }, { x: 0.48 - 0.26 * k, y: 0.5 }),
          hand('right', { x: 0.51 + 0.24 * k, y: 0.4 - 0.1 * k }, { x: 0.51 + 0.2 * k, y: 0.46 + 0.16 * k }, { x: 0.52 + 0.26 * k, y: 0.5 }),
        ];
      }
      break;
    }
    case 'lost': {
      const present = s % 2 < 1.2; // 1.2 s present, 0.8 s lost
      hands = present
        ? [
            hand('left', { x: 0.25, y: 0.3 }, { x: 0.3, y: 0.62 }, { x: 0.22, y: 0.55 }),
            hand('right', { x: 0.75, y: 0.32 }, { x: 0.7, y: 0.6 }, { x: 0.78, y: 0.55 }),
          ]
        : [];
      break;
    }
    case 'dwell': {
      // 3 s cycle: 0–2 s hold still with sub-tolerance jitter (±0.003), 2–3 s sweep out and back.
      // With dwellMs 1500 each cycle logs one `dwell` event ~1.5 s into the hold.
      const phase = s % 3;
      const jit = phase < 2 ? Math.sin(s * 37) * 0.003 : 0;
      const sweep = phase < 2 ? 0 : Math.sin((phase - 2) * Math.PI) * 0.12;
      hands = [
        hand('left', { x: 0.25 + sweep + jit, y: 0.3 }, { x: 0.3 + sweep, y: 0.62 + jit }, { x: 0.22 + sweep, y: 0.55 }),
        hand('right', { x: 0.75 + sweep, y: 0.32 + jit }, { x: 0.7 + sweep + jit, y: 0.6 }, { x: 0.78 + sweep, y: 0.55 }),
      ];
      break;
    }
  }
  return { t, sourceWidth: 1280, sourceHeight: 720, hands, face: null, segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } };
}

const interaction = createInteraction();
let scene: SceneState = { ...DEFAULT_SCENE };
const director = createDirector();
let scenario: Scenario = 'l-pose';
let scenarioStart = performance.now();
const log: string[] = [];
function pushLog(line: string): void {
  log.unshift(line);
  if (log.length > 14) log.pop();
}

scenarioEl.addEventListener('change', () => {
  scenario = scenarioEl.value as Scenario;
  scenarioStart = performance.now();
  interaction.reset();
});
const showSpring = (): void => {
  const v = Number(springEl.value) || 0;
  springOut.textContent = v > 0 ? v.toFixed(2) : 'off';
};
springEl.addEventListener('input', showSpring);
showSpring();
directorBtn.addEventListener('click', () => {
  if (director.running) {
    director.stop();
    directorBtn.textContent = 'Director: start';
  } else {
    director.start(performance.now());
    directorBtn.textContent = 'Director: stop';
  }
});

function settings(): InteractionSettings {
  return {
    ...DEFAULT_INTERACTION_SETTINGS,
    ordering: orderingEl.value === 'faithful' ? 'faithful' : 'convex',
    gestureCycleEnabled: gestureEl.checked,
    cornerSpring: Number(springEl.value) || 0,
    dwellMs: Number(dwellEl.value) || 0,
  };
}

function frameLoop(): void {
  const t = performance.now();
  const s = (t - scenarioStart) / 1000;
  const frame = synthFrame(scenario, s, t);
  const directed = director.update(t);
  if (directed) scene = directed;
  const out = interaction.update(frame, t, scene, settings());
  for (const ev of out.events) {
    pushLog(`${(t / 1000).toFixed(2)}s ${ev.type}${ev.type === 'cycle-persona' ? ` → ${ev.next}` : ''}`);
    if (ev.type === 'cycle-persona' && !director.running) scene = { ...scene, persona: ev.next };
  }

  const W = canvas.width;
  const H = canvas.height;
  ctx!.clearRect(0, 0, W, H);
  ctx!.fillStyle = scene.base === 'comic' ? '#3a2a1a' : '#141418';
  ctx!.fillRect(0, 0, W, H);
  if (out.quad) {
    const c = out.quad.corners;
    ctx!.save();
    ctx!.globalAlpha = out.quad.opacity;
    ctx!.fillStyle = scene.persona === 'portrait' ? '#f6f3ec' : scene.persona === 'masked' ? '#3b7bff' : '#ff4fb6';
    ctx!.beginPath();
    ctx!.moveTo(c[0].x * W, c[0].y * H);
    for (let i = 1; i < 4; i++) ctx!.lineTo(c[i]!.x * W, c[i]!.y * H);
    ctx!.closePath();
    ctx!.fill();
    ctx!.restore();
  }
  drawLandmarks(ctx!, frame, { width: W, height: H }, { quad: out.quad, debug: out.debug });
  ctx!.fillStyle = '#f5f5f7';
  ctx!.font = '20px system-ui';
  ctx!.fillText(`scene ${scene.base}/${scene.persona} hud=${scene.hudTint}  director=${director.running ? `step ${director.stepIndex(t)}` : 'off'}`, 16, 32);
  const pct = Math.round((out.debug.dwellProgress ?? 0) * 100);
  const dwellLine = `dwellProgress ${String(pct).padStart(3, ' ')}%  ${'█'.repeat(Math.round(pct / 5)).padEnd(20, '░')}  (dwellMs ${settings().dwellMs || 'off'})`;
  logEl.textContent = [dwellLine, ...log].join('\n');
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);
