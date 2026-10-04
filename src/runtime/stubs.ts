/**
 * TEST-ONLY no-op implementations of every module interface the runtime loop
 * consumes (`tests/unit/media/runtimeHarness.ts` wraps them to spy on call
 * order with deterministic behaviour). The app never resolves to a stub:
 * `src/runtime/factories.ts` imports the real modules and `modules.stubbed`
 * is always empty. The stub renderer draws the video cover-fit with a Canvas2D
 * context (when one exists); it is not a compositor.
 */
import type {
  AdaptiveQualityPolicy,
  CaptureAspect,
  CreateTracker,
  Director,
  Hud,
  HudModel,
  Interaction,
  InteractionOutput,
  PerfSample,
  PersonaId,
  PersonaLayer,
  QualitySettings,
  Recorder,
  RecorderOptions,
  RecorderState,
  Renderer,
  RenderInputs,
  SceneState,
  Size,
  StyleId,
  StylePreset,
  Tracker,
  TrackerOptions,
  TrackingFrame,
  WindowQuad,
} from '@/types';
import { REFERENCE_SEQUENCE } from '@/types';
import { computeCoverFit } from './viewport';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Creates an overlay canvas; in Node (no DOM) returns a size-only placeholder so tests can run. */
export function createOverlayCanvas(width: number, height: number): AnyCanvas {
  const g = globalThis as { OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
  if (typeof g.OffscreenCanvas === 'function') return new g.OffscreenCanvas(width, height);
  if (g.document) {
    const c = g.document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  return { width, height } as unknown as AnyCanvas;
}

function resizeCanvas(c: AnyCanvas, size: Size): void {
  if (c.width !== size.width) c.width = size.width;
  if (c.height !== size.height) c.height = size.height;
}

// ---------------------------------------------------------------- styles (W5)
const passthrough = { id: 'passthrough', frag: 'void main(){ fragColor = texture(u_color, v_uv); }' };
export const STUB_STYLE_PRESETS: Record<StyleId, StylePreset> = {
  'paper-portrait': { id: 'paper-portrait', passes: [passthrough], usesBackdrop: true },
  comic: { id: 'comic', passes: [passthrough], usesBackdrop: true },
};

/** Stub mapping mirroring W5 `presetForLayer`; the base comic preset must not replace the room with the persona backdrop. */
export function stubPresetForLayer(scene: SceneState, layer: 'base' | 'window'): StylePreset | null {
  if (layer === 'window') return scene.persona === 'portrait' ? STUB_STYLE_PRESETS['paper-portrait'] : STUB_STYLE_PRESETS.comic;
  return scene.base === 'comic' ? { ...STUB_STYLE_PRESETS.comic, usesBackdrop: false } : null;
}

// --------------------------------------------------------------- tracker (W3)
export const createStubTracker: CreateTracker = (opts = {}, onProgress) => {
  let ready = false;
  let options: TrackerOptions = { ...opts };
  let last: TrackingFrame | null = null;
  const tracker: Tracker = {
    async init() {
      onProgress?.(1);
      ready = true;
    },
    update(video, t) {
      const w = 'videoWidth' in video ? video.videoWidth : video.width;
      const h = 'videoHeight' in video ? video.videoHeight : video.height;
      if (last && last.t === t) return last;
      last = { t, sourceWidth: w, sourceHeight: h, hands: [], face: null, segmentation: null, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } };
      return last;
    },
    setOptions(partial) {
      options = { ...options, ...partial };
    },
    get ready() {
      return ready;
    },
    dispose() {
      ready = false;
      last = null;
    },
  };
  return tracker;
};

// -------------------------------------------------------------- renderer (W4)
export function createStubRenderer(): Renderer {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  const stats = { lastFrameMs: 0, passes: 0, gpuMs: null as number | null };
  return {
    async init(c) {
      canvas = c;
      ctx = typeof c.getContext === 'function' ? (c.getContext('2d') as CanvasRenderingContext2D | null) : null;
    },
    resize(cssWidth, cssHeight, dpr) {
      if (!canvas) return;
      const w = Math.max(1, Math.round(cssWidth * dpr));
      const h = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    },
    render(inputs: RenderInputs) {
      stats.passes = 0;
      if (!ctx || !canvas) return;
      const start = performance.now();
      const fit = computeCoverFit({ width: inputs.videoWidth, height: inputs.videoHeight }, { width: canvas.width, height: canvas.height });
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (inputs.videoWidth > 0 && inputs.videoHeight > 0) {
        // Single cover-fit presentation; mirror by flipping x once.
        if (inputs.mirrored) {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(inputs.video as CanvasImageSource, fit.offsetX, fit.offsetY, inputs.videoWidth * fit.scale, inputs.videoHeight * fit.scale);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // Overlays are in intrinsic video space: same cover-fit, no mirror (already mirrored data).
        const drawOverlay = (o: AnyCanvas | null) => {
          if (o && o.width > 0) ctx!.drawImage(o as CanvasImageSource, fit.offsetX, fit.offsetY, inputs.videoWidth * fit.scale, inputs.videoHeight * fit.scale);
        };
        if (inputs.quad?.visible) {
          const q = inputs.quad;
          ctx.globalAlpha = q.opacity;
          ctx.strokeStyle = '#ff4fb6';
          ctx.lineWidth = 2;
          ctx.beginPath();
          q.corners.forEach((p, i) => {
            const x = fit.offsetX + p.x * inputs.videoWidth * fit.scale;
            const y = fit.offsetY + p.y * inputs.videoHeight * fit.scale;
            if (i === 0) ctx!.moveTo(x, y);
            else ctx!.lineTo(x, y);
          });
          ctx.closePath();
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        drawOverlay(inputs.hudOverlay);
      }
      ctx.restore();
      stats.lastFrameMs = performance.now() - start;
      stats.passes = 1;
    },
    get canvas() {
      if (!canvas) throw new Error('stub renderer not initialised');
      return canvas;
    },
    stats,
    dispose() {
      ctx = null;
      canvas = null;
    },
  };
}

// --------------------------------------------------------------- persona (W6)
export function createStubPersonaLayer(): PersonaLayer {
  const overlay = createOverlayCanvas(1280, 720);
  const backdrop = createOverlayCanvas(1280, 720);
  let personaId: PersonaId = 'portrait';
  return {
    resize(size) {
      resizeCanvas(overlay, size);
      resizeCanvas(backdrop, size);
    },
    update(_frame, scene) {
      personaId = scene.persona;
    },
    overlay,
    backdrop,
    get personaId() {
      return personaId;
    },
  };
}

// ----------------------------------------------------------- interaction (W7)
export function createStubInteraction(): Interaction {
  const empty: InteractionOutput = { quad: null, events: [], debug: { armed: false, togetherMs: 0, handsUsed: 0 } };
  return {
    update(frame) {
      // Minimal quad from two hands so the loop/harness shows something; no gestures.
      if (!frame || frame.hands.length < 2) return { ...empty, events: [] };
      const [l, r] = frame.hands as [TrackingFrame['hands'][number], TrackingFrame['hands'][number]];
      const corners: WindowQuad['corners'] = [l.indexTip, r.indexTip, r.thumbTip, l.thumbTip];
      const thickness = (Math.hypot(l.indexTip.x - l.thumbTip.x, l.indexTip.y - l.thumbTip.y) + Math.hypot(r.indexTip.x - r.thumbTip.x, r.indexTip.y - r.thumbTip.y)) / 2;
      const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
      const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
      return {
        quad: { corners, opacity: 1, thickness, area: 0, centroid: { x: cx, y: cy }, visible: true, ordering: 'convex' },
        events: [],
        debug: { armed: false, togetherMs: 0, handsUsed: 2 },
      };
    },
    reset() {},
  };
}

export function createStubDirector(sequence = REFERENCE_SEQUENCE): Director {
  let running = false;
  let startT = 0;
  const total = sequence.reduce((s, st) => s + st.durationMs, 0);
  return {
    start(t) {
      running = true;
      startT = t;
    },
    stop() {
      running = false;
    },
    update(t): SceneState | null {
      if (!running) return null;
      let rel = total > 0 ? (t - startT) % total : 0;
      for (const step of sequence) {
        if (rel < step.durationMs) return { base: step.base, persona: step.persona, hudTint: step.base === 'comic' ? 'red' : 'white' };
        rel -= step.durationMs;
      }
      const last = sequence[sequence.length - 1];
      return last ? { base: last.base, persona: last.persona, hudTint: last.base === 'comic' ? 'red' : 'white' } : null;
    },
    get running() {
      return running;
    },
  };
}

// ------------------------------------------------------------------- HUD (W8)
export function createStubHud(): Hud {
  const canvas = createOverlayCanvas(1280, 720);
  return {
    resize(size) {
      resizeCanvas(canvas, size);
    },
    buildModel(_frame, quad, scene, _t, extras): HudModel {
      return { tint: scene.hudTint, callouts: [], opacity: quad?.opacity ?? 0, recording: extras.recording, fps: extras.showFps ? extras.fps : null };
    },
    draw() {},
    canvas,
  };
}

// --------------------------------------------------------- capture/perf (W9)
export function createStubRecorder(_getCanvas: () => HTMLCanvasElement): Recorder {
  let state: RecorderState = 'idle';
  let startedAt = 0;
  let mime = 'video/webm';
  return {
    get state() {
      return state;
    },
    get elapsedMs() {
      return state === 'idle' ? 0 : performance.now() - startedAt;
    },
    async start(opts: RecorderOptions) {
      if (state !== 'idle') throw new Error('Recorder already running');
      mime = opts.mimeCandidates?.[0] ?? 'video/webm';
      startedAt = performance.now();
      state = 'recording';
    },
    async stop() {
      const durationMs = performance.now() - startedAt;
      state = 'idle';
      return { blob: new Blob([], { type: mime }), mime, durationMs };
    },
    async snapshot(_aspect: CaptureAspect) {
      return new Blob([], { type: 'image/png' });
    },
  };
}

export interface PerfMonitor {
  sample(s: Omit<PerfSample, 't' | 'fps'>): void;
  fps(): number;
  recent(ms: number): PerfSample[];
}

export function createStubPerfMonitor(): PerfMonitor {
  const ring: PerfSample[] = [];
  let ema = 0;
  return {
    sample(s) {
      const t = performance.now();
      const inst = s.frameMs > 0 ? 1000 / s.frameMs : 0;
      ema = ema === 0 ? inst : ema * 0.9 + inst * 0.1;
      ring.push({ ...s, t, fps: ema });
      while (ring.length > 300) ring.shift();
    },
    fps: () => ema,
    recent(ms) {
      const cutoff = performance.now() - ms;
      return ring.filter((p) => p.t >= cutoff);
    },
  };
}

export const stubAdaptivePolicy: AdaptiveQualityPolicy = {
  evaluate(_samples: PerfSample[], _current: QualitySettings) {
    return null;
  },
};
