/**
 * Mock tracking for e2e (owner: W10).
 *
 * MediaPipe will not reliably detect the synthetic hands in tests/fixtures/hands.y4m, so the
 * e2e suite drives the runtime through the DEV-ONLY test hook `window.__alterframe.injectTracking`
 * (src/types/runtime.ts). The hook exists only when the app runs on the Vite dev server with
 * `?mockTracking=1`; production builds never expose it.
 *
 * `buildTrackingFrame` is deliberately self-contained (no imports, no closures) so it can be
 * serialised with `Function.prototype.toString()` and installed in the page via `addScriptTag`.
 * The same function is unit-tested in Node (tests/unit/infra/mock-tracking.test.ts).
 */
import type { Page } from '@playwright/test';
import type { TrackingFrame, HandTrack, FaceTrack } from '@/types';
import schedule from '../../fixtures/hands.schedule.json' with { type: 'json' };

export interface Pt { x: number; y: number }
export interface MockHand { side: 'left' | 'right'; palmCenter: Pt; indexTip: Pt; thumbTip: Pt }
export interface MockFace { center: Pt; leftEye: Pt; rightEye: Pt; box: { x: number; y: number; w: number; h: number } }
export interface MockSample { t: number; phase: string; together: boolean; hands: MockHand[]; face: MockFace | null }

export const SCHEDULE_SAMPLES: MockSample[] = schedule.samples.map((s) => ({
  t: s.t,
  phase: s.phase,
  together: s.together,
  hands: s.hands.map((h) => ({ side: h.side as 'left' | 'right', palmCenter: h.palmCenter, indexTip: h.indexTip, thumbTip: h.thumbTip })),
  face: s.face,
}));

/** Face-oval landmark indices used by the persona layer (MediaPipe face-mesh oval, clockwise from the forehead). */
export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

/**
 * Build a full TrackingFrame from a schedule sample. PURE and SELF-CONTAINED — do not add
 * references to anything outside this function body (it is stringified into the page).
 *
 * @param sample   schedule sample in display space
 * @param t        timestamp (ms) to stamp on the frame
 * @param opts     sourceWidth/Height, mouthOpen override, handsOverride (0|1|2) to drop hands
 */
export function buildTrackingFrame(
  sample: MockSample,
  t: number,
  opts: { sourceWidth?: number; sourceHeight?: number; mouthOpen?: number; handCount?: 0 | 1 | 2; withFace?: boolean; withSegmentation?: boolean } = {},
): TrackingFrame {
  const sw = opts.sourceWidth ?? 640;
  const sh = opts.sourceHeight ?? 360;
  const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
  const mix = (a: Pt, b: Pt, u: number): Pt => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) });

  const makeHand = (h: MockHand): HandTrack => {
    const palm = h.palmCenter;
    const inward = h.side === 'left' ? 1 : -1;
    const wrist: Pt = { x: palm.x - inward * 0.01, y: palm.y + 0.08 };
    const indexMcp: Pt = { x: palm.x, y: palm.y - 0.035 };
    const middleMcp: Pt = { x: palm.x - inward * 0.018, y: palm.y - 0.04 };
    const ringMcp: Pt = { x: palm.x - inward * 0.034, y: palm.y - 0.032 };
    const pinkyMcp: Pt = { x: palm.x - inward * 0.048, y: palm.y - 0.018 };
    const lm: Pt[] = new Array<Pt>(21);
    lm[0] = wrist;
    // Thumb chain 1..4: wrist → thumb tip.
    for (let i = 1; i <= 4; i++) lm[i] = mix(wrist, h.thumbTip, i / 4);
    // Index chain 5..8: MCP → tip (straight up in L pose).
    for (let i = 5; i <= 8; i++) lm[i] = mix(indexMcp, h.indexTip, (i - 5) / 3);
    // Middle/ring/pinky folded: tips curl back toward the palm.
    const folded = (mcp: Pt, base: number): void => {
      lm[base] = mcp;
      lm[base + 1] = { x: mcp.x - inward * 0.012, y: mcp.y - 0.02 };
      lm[base + 2] = { x: mcp.x - inward * 0.02, y: mcp.y + 0.005 };
      lm[base + 3] = { x: mcp.x - inward * 0.014, y: mcp.y + 0.02 };
    };
    folded(middleMcp, 9);
    folded(ringMcp, 13);
    folded(pinkyMcp, 17);
    const landmarks = lm.map((p) => ({ x: p.x, y: p.y, z: 0 }));
    const palmPts = [lm[0], lm[5], lm[9], lm[13], lm[17]] as Pt[];
    const palmCenter: Pt = {
      x: palmPts.reduce((s, p) => s + p.x, 0) / 5,
      y: palmPts.reduce((s, p) => s + p.y, 0) / 5,
    };
    const size = Math.hypot((wrist.x - middleMcp.x) * (sw / sh), wrist.y - middleMcp.y);
    return {
      side: h.side,
      landmarks,
      score: 0.97,
      indexTip: { x: h.indexTip.x, y: h.indexTip.y },
      thumbTip: { x: h.thumbTip.x, y: h.thumbTip.y },
      palmCenter,
      size,
    };
  };

  const makeFace = (f: MockFace): FaceTrack => {
    const c = f.center;
    const rx = f.box.w / 2;
    const ry = f.box.h / 2;
    // 478 landmarks on a deterministic spiral inside the face ellipse (468 mesh + 10 iris).
    const landmarks = new Array<{ x: number; y: number; z: number }>(478);
    for (let i = 0; i < 478; i++) {
      const u = (i + 0.5) / 478;
      const r = Math.sqrt(u) * 0.92;
      const a = i * 2.399963; // golden angle
      landmarks[i] = { x: c.x + Math.cos(a) * r * rx, y: c.y + Math.sin(a) * r * ry, z: 0 };
    }
    // Face oval (W6 polygon) placed exactly on the ellipse, clockwise from the forehead.
    const oval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
    for (let k = 0; k < oval.length; k++) {
      const a = -Math.PI / 2 + (k / oval.length) * Math.PI * 2;
      landmarks[oval[k] as number] = { x: c.x + Math.cos(a) * rx, y: c.y + Math.sin(a) * ry, z: 0 };
    }
    const set = (idx: number, p: Pt): void => {
      landmarks[idx] = { x: p.x, y: p.y, z: 0 };
    };
    const le = f.leftEye;
    const re = f.rightEye;
    const eyeW = rx * 0.42;
    const eyeH = ry * 0.09;
    // Eye corners/lids. FACE_LM "LEFT" (263/362/386/374/473) is the eye on SCREEN-LEFT.
    set(263, { x: le.x - eyeW / 2, y: le.y });
    set(362, { x: le.x + eyeW / 2, y: le.y });
    set(386, { x: le.x, y: le.y - eyeH });
    set(374, { x: le.x, y: le.y + eyeH });
    set(473, le);
    set(33, { x: re.x + eyeW / 2, y: re.y });
    set(133, { x: re.x - eyeW / 2, y: re.y });
    set(159, { x: re.x, y: re.y - eyeH });
    set(145, { x: re.x, y: re.y + eyeH });
    set(468, re);
    // Brows, cheeks, nose, chin, forehead, mouth.
    set(300, { x: le.x - eyeW * 0.6, y: le.y - ry * 0.16 });
    set(336, { x: le.x + eyeW * 0.4, y: le.y - ry * 0.18 });
    set(70, { x: re.x + eyeW * 0.6, y: re.y - ry * 0.16 });
    set(107, { x: re.x - eyeW * 0.4, y: re.y - ry * 0.18 });
    set(425, { x: le.x, y: c.y + ry * 0.2 });
    set(205, { x: re.x, y: c.y + ry * 0.2 });
    set(1, { x: c.x, y: c.y + ry * 0.12 });
    set(152, { x: c.x, y: c.y + ry });
    set(10, { x: c.x, y: c.y - ry });
    const mouthOpen = opts.mouthOpen ?? 0.05;
    const mouthY = c.y + ry * 0.55;
    set(61, { x: c.x - rx * 0.45, y: mouthY });
    set(291, { x: c.x + rx * 0.45, y: mouthY });
    set(13, { x: c.x, y: mouthY - ry * 0.03 });
    set(14, { x: c.x, y: mouthY + ry * 0.03 + mouthOpen * ry * 0.3 });
    return {
      landmarks,
      blendshapes: { eyeBlinkLeft: 0.02, eyeBlinkRight: 0.02, jawOpen: mouthOpen, mouthSmileLeft: 0.2, mouthSmileRight: 0.2 },
      transform: null,
      leftEye: { x: le.x, y: le.y },
      rightEye: { x: re.x, y: re.y },
      noseTip: { x: c.x, y: c.y + ry * 0.12 },
      chin: { x: c.x, y: c.y + ry },
      forehead: { x: c.x, y: c.y - ry },
      faceBox: { x: f.box.x, y: f.box.y, w: f.box.w, h: f.box.h },
      roll: 0,
      eyeOpenLeft: 0.98,
      eyeOpenRight: 0.98,
      mouthOpen,
      smile: 0.2,
    };
  };

  const handCount = opts.handCount ?? 2;
  const hands = sample.hands
    .slice(0, handCount)
    .map(makeHand)
    .sort((a, b) => a.palmCenter.x - b.palmCenter.x);
  // `side` is assigned by screen position after sorting (contract: W3 §2).
  if (hands.length === 2) {
    hands[0]!.side = 'left';
    hands[1]!.side = 'right';
  }
  const withFace = opts.withFace ?? true;

  /**
   * Synthetic person-confidence mask (256×256, display space, top-left origin): head ellipse,
   * torso block below the chin, hand discs + finger bars. Mirrors what the fixture draws so the
   * backdrop replacement inside the window has a background to replace.
   */
  const makeSegmentation = (): TrackingFrame['segmentation'] => {
    const W = 256;
    const H = 256;
    const data = new Float32Array(W * H);
    const aspect = sw / sh; // display x is normalized by width, y by height → correct distances
    const fill = (cx: number, cy: number, rx: number, ry: number): void => {
      const x0 = Math.max(0, Math.floor((cx - rx) * W));
      const x1 = Math.min(W - 1, Math.ceil((cx + rx) * W));
      const y0 = Math.max(0, Math.floor((cy - ry) * H));
      const y1 = Math.min(H - 1, Math.ceil((cy + ry) * H));
      for (let y = y0; y <= y1; y++) {
        const dy = ((y + 0.5) / H - cy) / ry;
        for (let x = x0; x <= x1; x++) {
          const dx = ((x + 0.5) / W - cx) / rx;
          if (dx * dx + dy * dy <= 1) data[y * W + x] = 1;
        }
      }
    };
    if (sample.face) {
      const f = sample.face;
      const rx = f.box.w / 2;
      const ry = f.box.h / 2;
      fill(f.center.x, f.center.y + ry * 1.9, rx * 2.6, ry * 1.4); // torso
      fill(f.center.x, f.center.y, rx, ry); // head
    }
    for (const h of sample.hands.slice(0, handCount)) {
      const pr = 0.045;
      fill(h.palmCenter.x, h.palmCenter.y, pr / aspect, pr);
      // index bar: discs along the bar
      for (let k = 0; k <= 6; k++) fill(h.palmCenter.x, h.palmCenter.y + (h.indexTip.y - h.palmCenter.y) * (k / 6), 0.009, 0.016);
      for (let k = 0; k <= 4; k++) fill(h.palmCenter.x + (h.thumbTip.x - h.palmCenter.x) * (k / 4), h.thumbTip.y, 0.009, 0.016);
    }
    return { width: W, height: H, data, texture: null };
  };

  return {
    t,
    sourceWidth: sw,
    sourceHeight: sh,
    hands,
    face: withFace && sample.face ? makeFace(sample.face) : null,
    segmentation: (opts.withSegmentation ?? true) ? makeSegmentation() : null,
    timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 },
  };
}

/** Nearest-sample lookup with linear interpolation between neighbours (pure, Node-side). */
export function sampleAt(tSeconds: number, samples: MockSample[] = SCHEDULE_SAMPLES): MockSample {
  const step = samples[1]!.t - samples[0]!.t;
  const i = Math.max(0, Math.min(samples.length - 1, Math.floor(tSeconds / step)));
  const a = samples[i]!;
  const b = samples[Math.min(samples.length - 1, i + 1)]!;
  const u = Math.max(0, Math.min(1, (tSeconds - a.t) / step));
  const mix = (p: Pt, q: Pt): Pt => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });
  return {
    t: tSeconds,
    phase: u < 0.5 ? a.phase : b.phase,
    together: u < 0.5 ? a.together : b.together,
    hands: a.hands.map((h, k) => {
      const o = b.hands[k] ?? h;
      return { side: h.side, palmCenter: mix(h.palmCenter, o.palmCenter), indexTip: mix(h.indexTip, o.indexTip), thumbTip: mix(h.thumbTip, o.thumbTip) };
    }),
    face: a.face,
  };
}

/** Samples that are in a given phase (helper for assertions). */
export function samplesInPhase(name: string, samples: MockSample[] = SCHEDULE_SAMPLES): MockSample[] {
  return samples.filter((s) => s.phase === name);
}

// ------------------------------------------------------------------------------------------------
// Page driver
// ------------------------------------------------------------------------------------------------

declare global {
  interface Window {
    __alterframeMock?: {
      /** Start pushing frames each animation frame from `samples`, looping at `loopS`. */
      start(samples: MockSample[], opts?: { loopS?: number; speed?: number; handCount?: 0 | 1 | 2; withFace?: boolean }): void;
      /** Hold one fixed sample (e.g. for screenshots). */
      hold(sample: MockSample, opts?: { handCount?: 0 | 1 | 2; withFace?: boolean; mouthOpen?: number }): void;
      /**
       * Play a timed sequence of poses entirely in-page (no CDP round trips between steps), so
       * hold durations are honest even when the page is slow. The last step holds indefinitely.
       */
      sequence(steps: { sample: MockSample; ms: number; opts?: { handCount?: 0 | 1 | 2; withFace?: boolean } }[]): void;
      /** performance.now() of the first pushed frame of each sequence step (filled as steps start). */
      stepFirstPushAt: number[];
      stop(): void;
      frames: number;
      lastFrame: TrackingFrame | null;
      /** performance.now() at which the FIRST frame of the current hold()/start() was pushed. */
      firstPushAt: number;
      ready(): boolean;
    };
  }
}

/** Serialised builder + driver, installed with addScriptTag (works regardless of bundler transforms). */
function driverSource(): string {
  const build = buildTrackingFrame.toString();
  return `
(() => {
  const build = ${build};
  let raf = 0; let frames = 0; let lastFrame = null; let firstPushAt = 0; let pending = false; let stepFirstPushAt = [];
  const handle = () => window.__alterframe;
  const push = (frame) => { const h = handle(); if (h && typeof h.injectTracking === 'function') { h.injectTracking(frame); frames++; lastFrame = frame; if (pending) { pending = false; firstPushAt = performance.now(); } } };
  const api = {
    get frames() { return frames; },
    get lastFrame() { return lastFrame; },
    get firstPushAt() { return firstPushAt; },
    get stepFirstPushAt() { return stepFirstPushAt; },
    sequence(steps) {
      api.stop();
      pending = true;
      stepFirstPushAt = [];
      let i = 0; let stepStart = 0;
      const loop = () => {
        const now = performance.now();
        if (stepFirstPushAt.length === i) { stepFirstPushAt.push(0); stepStart = now; }
        const step = steps[i];
        push(build(step.sample, now, step.opts || {}));
        if (stepFirstPushAt[i] === 0) stepFirstPushAt[i] = performance.now();
        if (i < steps.length - 1 && now - stepStart >= step.ms) i++;
        raf = requestAnimationFrame(loop);
      };
      loop();
    },
    ready() { const h = handle(); return !!(h && typeof h.injectTracking === 'function'); },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; const h = handle(); if (h && typeof h.injectTracking === 'function') h.injectTracking(null); },
    hold(sample, opts) {
      api.stop();
      pending = true;
      const loop = () => { push(build(sample, performance.now(), opts || {})); raf = requestAnimationFrame(loop); };
      loop();
    },
    start(samples, opts) {
      api.stop();
      pending = true;
      const o = opts || {};
      const step = samples[1].t - samples[0].t;
      const loopS = o.loopS ?? samples[samples.length - 1].t;
      const speed = o.speed ?? 1;
      const t0 = performance.now();
      const mix = (p, q, u) => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });
      const loop = () => {
        const now = performance.now();
        const ts = (((now - t0) / 1000) * speed) % loopS;
        const i = Math.max(0, Math.min(samples.length - 1, Math.floor(ts / step)));
        const a = samples[i]; const b = samples[Math.min(samples.length - 1, i + 1)];
        const u = Math.max(0, Math.min(1, (ts - a.t) / step));
        const sample = { t: ts, phase: u < 0.5 ? a.phase : b.phase, together: u < 0.5 ? a.together : b.together, face: a.face,
          hands: a.hands.map((h, k) => { const q = b.hands[k] || h; return { side: h.side, palmCenter: mix(h.palmCenter, q.palmCenter, u), indexTip: mix(h.indexTip, q.indexTip, u), thumbTip: mix(h.thumbTip, q.thumbTip, u) }; }) };
        push(build(sample, now, { handCount: o.handCount, withFace: o.withFace }));
        raf = requestAnimationFrame(loop);
      };
      loop();
    },
  };
  window.__alterframeMock = api;
})();`;
}

/** Install the in-page driver. Call after navigation (and after every reload). */
export async function installMockDriver(page: Page): Promise<void> {
  await page.addScriptTag({ content: driverSource() });
  await page.waitForFunction(() => typeof window.__alterframeMock !== 'undefined');
}

/** Wait until the runtime exposes `injectTracking` (dev + `?mockTracking=1`). */
export async function waitForInjectHook(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => window.__alterframeMock?.ready() === true, undefined, { timeout });
}

/** Hold a pose; resolves with the page time at which its first frame reached the runtime. */
export async function holdSample(page: Page, sample: MockSample, opts: { handCount?: 0 | 1 | 2; withFace?: boolean; mouthOpen?: number } = {}): Promise<number> {
  await page.evaluate(([s, o]) => window.__alterframeMock!.hold(s, o), [sample, opts] as const);
  await page.waitForFunction(() => window.__alterframeMock!.firstPushAt > 0 && performance.now() - window.__alterframeMock!.firstPushAt < 5000);
  return page.evaluate(() => window.__alterframeMock!.firstPushAt);
}

/** Run a timed pose sequence in-page; returns the first-push timestamps of each step once ALL steps have started. */
export async function holdSequence(page: Page, steps: { sample: MockSample; ms: number; opts?: { handCount?: 0 | 1 | 2; withFace?: boolean } }[], timeout = 30_000): Promise<number[]> {
  await page.evaluate((st) => window.__alterframeMock!.sequence(st), steps);
  await page.waitForFunction((n) => {
    const arr = window.__alterframeMock!.stepFirstPushAt;
    return arr.length === n && arr.every((t) => t > 0);
  }, steps.length, { timeout });
  return page.evaluate(() => window.__alterframeMock!.stepFirstPushAt);
}

export async function playSchedule(page: Page, opts: { loopS?: number; speed?: number; handCount?: 0 | 1 | 2; withFace?: boolean } = {}): Promise<void> {
  await page.evaluate(([samples, o]) => window.__alterframeMock!.start(samples, o), [SCHEDULE_SAMPLES, opts] as const);
}

export async function stopMock(page: Page): Promise<void> {
  await page.evaluate(() => window.__alterframeMock?.stop());
}

/** A few named poses for screenshots and quad assertions. */
export const POSES = {
  together: SCHEDULE_SAMPLES.find((s) => s.t === 1)!,
  skewed: SCHEDULE_SAMPLES.find((s) => s.t === 5)!,
  wide: SCHEDULE_SAMPLES.find((s) => s.t === 11)!,
};
