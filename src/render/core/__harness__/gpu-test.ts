/**
 * GPU test harness for tests/unit/render-core/gpu.test.ts (Playwright drives this page on a real
 * WebGL2 context). Builds a RenderInputs from a serialisable SceneSpec, renders N frames and reads
 * back probe pixels. Not imported by the app. The real style presets are imported only so the
 * warm-up test can compile the shipped chains.
 */
import type { FitMode, QuadCorners, RenderInputs, SegmentationResult, StylePass, StylePreset, WindowQuad } from '@/types';
import { DEFAULT_QUALITY, DEFAULT_SCENE } from '@/types';
import { STYLE_PRESETS } from '@/render/styles';
import { canvasPxToDisplay, compilePass, createRenderer, displayToCanvasPx, fitFor, passthrough, presetOf, solid, type CoreRenderer } from '../index';

type Rgb = [number, number, number];

export interface Dot { x: number; y: number; r: number; color: string }

export interface LayerSpec {
  /** Canvas size in px; defaults to the video size (video-space, per integration agreement). */
  w?: number;
  h?: number;
  fill?: string;
  dots?: Dot[];
  /** Set the `__dirty` flag on the produced canvas (undefined = flag absent). */
  dirty?: boolean;
}

export type PassSpec = 'passthrough' | { solid: Rgb } | { frag: string; scale?: number; id?: string };
/** `{ preset }` runs one of the real style presets (src/render/styles.ts). */
export type StyleSpec = 'live' | PassSpec | { chain: PassSpec[] } | { preset: keyof typeof STYLE_PRESETS };

export interface SceneSpec {
  css?: { w: number; h: number; dpr?: number };
  /** Present-pass mapping (default 'cover', the v0.1 behaviour). */
  fitMode?: FitMode;
  video?: { w: number; h: number; pattern: 'halves' | 'quadrants' | 'solid' | 'dot'; color?: string; dot?: Dot };
  mirrored?: boolean;
  quad?: QuadCorners | null;
  opacity?: number;
  glitch?: number;
  base?: StyleSpec;
  window?: StyleSpec;
  overlay?: LayerSpec | null;
  backdrop?: LayerSpec | null;
  hud?: LayerSpec | null;
  /** Mask: 'topleft' = 1 in the top-left quadrant, 0 elsewhere (256×256). */
  mask?: 'topleft' | 'left' | null;
  renderScale?: number;
  frames?: number;
  time?: number;
  /** Probe positions in DISPLAY space; converted to canvas px through the renderer's fit. */
  probes?: { x: number; y: number }[];
  /** Probe positions in canvas pixels. */
  probesPx?: { x: number; y: number }[];
  /** Keep the previous renderer/canvas sources (for dirty-flag tests). */
  reuse?: boolean;
}

export interface SceneResult {
  backing: { w: number; h: number };
  internal: { w: number; h: number };
  fit: { mode: FitMode; uvScale: [number, number]; uvOffset: [number, number] };
  probes: [number, number, number, number][];
  probesPx: [number, number, number, number][];
  probePx: { x: number; y: number }[];
  stats: { lastFrameMs: number; passes: number; gpuMs: number | null };
  uploads: { video: number; overlay: number; mask: number; skippedOverlay: number };
  maskFormat: string;
  /** Linked programs in the compositor's cache after this run. */
  programs: number;
  /** Whether the timer-query extension exists on this context. */
  gpuTimer: boolean;
  /** gl.getError() after the run (0 = NO_ERROR). */
  glError: number;
  contextLost: boolean;
  contextLossCount: number;
}

export interface WarmResult {
  /** Programs in the cache before/after the warm-up. */
  programsBefore: number;
  programsAfter: number;
  /** Distinct pass fragment sources across the warmed presets (= programs the warm-up must add). */
  distinctPasses: number;
  /** `isWarm()` for every preset before the call / after the queue drained. */
  warmBefore: boolean;
  allWarm: boolean;
  /** Presets still queued right after `warm()` returned (0 = ran synchronously). */
  pendingAfterCall: number;
  /** gl.getError() after the warm-up drained (0 = NO_ERROR). */
  glError: number;
}

export interface W4Harness {
  ready: boolean;
  error?: string;
  run(spec: SceneSpec): SceneResult;
  compile(frag: string): { ok: boolean; log: string };
  /** Simulate a context loss; resolves after the restored event fired (or times out). */
  loseAndRestore(): Promise<{ lostSeen: boolean; restoredSeen: boolean; renderDuringLoss: SceneResult }>;
  /** Re-render the last spec with a different dirty flag on the overlay canvas. */
  rerenderOverlay(dirty: boolean | undefined): SceneResult;
  readPixel(x: number, y: number): [number, number, number, number];
  display(p: { x: number; y: number }): { x: number; y: number };
  /** `renderer.warm()` with every real style preset (twice, to prove idempotence); resolves when the queue drained. */
  warmAll(): Promise<WarmResult>;
  /** Render the last spec `frames` more times (over animation frames) and report the stats. */
  pump(frames: number): Promise<{ gpuMs: number | null; gpuTimer: boolean; extensionPresent: boolean; passes: number }>;
}

declare global {
  interface Window { __w4?: W4Harness }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawDots(ctx: CanvasRenderingContext2D, dots: Dot[] | undefined, w: number, h: number): void {
  for (const d of dots ?? []) {
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(d.x * w, d.y * h, d.r * Math.min(w, h), 0, Math.PI * 2);
    ctx.fill();
  }
}

function videoCanvas(spec: NonNullable<SceneSpec['video']>): HTMLCanvasElement {
  const c = makeCanvas(spec.w, spec.h);
  const ctx = c.getContext('2d')!;
  switch (spec.pattern) {
    case 'halves':
      ctx.fillStyle = '#00ff00'; // source-left green
      ctx.fillRect(0, 0, spec.w / 2, spec.h);
      ctx.fillStyle = '#ffff00'; // source-right yellow
      ctx.fillRect(spec.w / 2, 0, spec.w / 2, spec.h);
      break;
    case 'quadrants':
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, spec.w / 2, spec.h / 2); // TL red
      ctx.fillStyle = '#00ff00'; ctx.fillRect(spec.w / 2, 0, spec.w / 2, spec.h / 2); // TR green
      ctx.fillStyle = '#0000ff'; ctx.fillRect(0, spec.h / 2, spec.w / 2, spec.h / 2); // BL blue
      ctx.fillStyle = '#ffffff'; ctx.fillRect(spec.w / 2, spec.h / 2, spec.w / 2, spec.h / 2); // BR white
      break;
    case 'solid':
      ctx.fillStyle = spec.color ?? '#204080';
      ctx.fillRect(0, 0, spec.w, spec.h);
      break;
    case 'dot':
      ctx.fillStyle = spec.color ?? '#202020';
      ctx.fillRect(0, 0, spec.w, spec.h);
      drawDots(ctx, spec.dot ? [spec.dot] : [], spec.w, spec.h);
      break;
  }
  return c;
}

function layerCanvas(spec: LayerSpec, vw: number, vh: number): HTMLCanvasElement & { __dirty?: boolean } {
  const w = spec.w ?? vw;
  const h = spec.h ?? vh;
  const c = makeCanvas(w, h) as HTMLCanvasElement & { __dirty?: boolean };
  const ctx = c.getContext('2d')!;
  if (spec.fill) {
    ctx.fillStyle = spec.fill;
    ctx.fillRect(0, 0, w, h);
  }
  drawDots(ctx, spec.dots, w, h);
  if (spec.dirty !== undefined) c.__dirty = spec.dirty;
  return c;
}

function passOf(spec: PassSpec): StylePass {
  if (spec === 'passthrough') return passthrough;
  if ('solid' in spec) return solid(spec.solid);
  const pass: StylePass = { id: spec.id ?? 'custom', frag: spec.frag };
  if (spec.scale !== undefined) pass.scale = spec.scale;
  return pass;
}

function styleOf(spec: StyleSpec | undefined, id: StylePreset['id']): StylePreset | null {
  if (!spec || spec === 'live') return null;
  if (typeof spec === 'object' && 'preset' in spec) return STYLE_PRESETS[spec.preset];
  if (typeof spec === 'object' && 'chain' in spec) return presetOf(spec.chain.map(passOf), id);
  return presetOf([passOf(spec)], id);
}

function quadOf(corners: QuadCorners, opacity: number): WindowQuad {
  const [a, b, c, d] = corners;
  const area = Math.abs(a.x * b.y - b.x * a.y + (b.x * c.y - c.x * b.y) + (c.x * d.y - d.x * c.y) + (d.x * a.y - a.x * d.y)) / 2;
  return {
    corners,
    opacity,
    thickness: (Math.hypot(a.x - d.x, a.y - d.y) + Math.hypot(b.x - c.x, b.y - c.y)) / 2,
    area,
    centroid: { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 },
    visible: true,
    ordering: 'convex',
  };
}

function maskOf(kind: 'topleft' | 'left'): SegmentationResult {
  const n = 256;
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const inside = kind === 'left' ? x < n / 2 : x < n / 2 && y < n / 2;
      data[y * n + x] = inside ? 1 : 0;
    }
  }
  return { width: n, height: n, data, texture: null };
}

async function main(): Promise<void> {
  const api: W4Harness = {
    ready: false,
    run: () => { throw new Error('not ready'); },
    compile: () => ({ ok: false, log: 'not ready' }),
    loseAndRestore: () => Promise.reject(new Error('not ready')),
    rerenderOverlay: () => { throw new Error('not ready'); },
    readPixel: () => [0, 0, 0, 0],
    display: (p) => p,
    warmAll: () => Promise.reject(new Error('not ready')),
    pump: () => Promise.reject(new Error('not ready')),
  };
  window.__w4 = api;
  const stage = document.getElementById('stage') as HTMLCanvasElement;
  let renderer: CoreRenderer | null = null;
  let lastInputs: RenderInputs | null = null;
  let lastSpec: SceneSpec | null = null;
  let overlayCanvas: (HTMLCanvasElement & { __dirty?: boolean }) | null = null;
  let lostSeen = false;
  let restoredSeen = false;
  stage.addEventListener('webglcontextlost', () => { lostSeen = true; });
  stage.addEventListener('webglcontextrestored', () => { restoredSeen = true; });

  const readPixel = (x: number, y: number): [number, number, number, number] => {
    const gl = renderer?.gl;
    if (!gl) return [0, 0, 0, 0];
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // readPixels origin is bottom-left; convert from top-left canvas pixel.
    gl.readPixels(Math.floor(x), gl.drawingBufferHeight - 1 - Math.floor(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0]!, px[1]!, px[2]!, px[3]!];
  };

  const result = (spec: SceneSpec): SceneResult => {
    const r = renderer!;
    const dbg = r.getDebug();
    const vw = spec.video?.w ?? 640;
    const vh = spec.video?.h ?? 360;
    const mode: FitMode = spec.fitMode ?? 'cover';
    // Probe positions go through the same pure mapping the compositor uses for this mode.
    const fit = fitFor(mode, vw, vh, stage.width, stage.height);
    const probePx = (spec.probes ?? []).map((p) => displayToCanvasPx(p, stage.width, stage.height, fit));
    const gl = r.gl;
    return {
      backing: { w: stage.width, h: stage.height },
      internal: { w: dbg?.internalWidth ?? 0, h: dbg?.internalHeight ?? 0 },
      fit: dbg?.fit ?? { mode, uvScale: fit.uvScale, uvOffset: fit.uvOffset },
      probes: probePx.map((p) => readPixel(p.x, p.y)),
      probesPx: (spec.probesPx ?? []).map((p) => readPixel(p.x, p.y)),
      probePx,
      stats: { ...r.stats },
      uploads: dbg ? { ...dbg.uploads } : { video: 0, overlay: 0, mask: 0, skippedOverlay: 0 },
      maskFormat: dbg?.maskFormat ?? 'none',
      programs: dbg?.programs ?? 0,
      gpuTimer: dbg?.gpuTimer ?? false,
      glError: gl && !gl.isContextLost() ? gl.getError() : 0,
      contextLost: r.contextLost,
      contextLossCount: r.contextLossCount,
    };
  };

  const render = (spec: SceneSpec): SceneResult => {
    const r = renderer!;
    const css = spec.css ?? { w: 640, h: 360, dpr: 1 };
    stage.style.width = `${css.w}px`;
    stage.style.height = `${css.h}px`;
    r.resize(css.w, css.h, css.dpr ?? 1);
    const videoSpec = spec.video ?? { w: 640, h: 360, pattern: 'solid' as const };
    const video = videoCanvas(videoSpec);
    if (!spec.reuse || !overlayCanvas) overlayCanvas = spec.overlay ? layerCanvas(spec.overlay, videoSpec.w, videoSpec.h) : null;
    const inputs: RenderInputs = {
      video,
      videoWidth: videoSpec.w,
      videoHeight: videoSpec.h,
      mirrored: spec.mirrored ?? false,
      tracking: spec.mask
        ? { t: 1, sourceWidth: videoSpec.w, sourceHeight: videoSpec.h, hands: [], face: null, segmentation: maskOf(spec.mask), timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } }
        : null,
      quad: spec.quad ? quadOf(spec.quad, spec.opacity ?? 1) : null,
      scene: { ...DEFAULT_SCENE },
      baseStyle: styleOf(spec.base, 'comic'),
      windowStyle: styleOf(spec.window, 'paper-portrait') ?? presetOf([passthrough], 'paper-portrait'),
      personaOverlay: overlayCanvas,
      personaBackdrop: spec.backdrop ? layerCanvas(spec.backdrop, videoSpec.w, videoSpec.h) : null,
      hudOverlay: spec.hud ? layerCanvas(spec.hud, videoSpec.w, videoSpec.h) : null,
      glitch: spec.glitch ?? 0,
      quality: { ...DEFAULT_QUALITY, renderScale: spec.renderScale ?? 1 },
      fitMode: spec.fitMode ?? 'cover',
      time: spec.time ?? 0,
    };
    const frames = spec.frames ?? 1;
    for (let i = 0; i < frames; i++) r.render({ ...inputs, time: (spec.time ?? 0) + i / 60 });
    lastInputs = inputs;
    lastSpec = spec;
    return result(spec);
  };

  try {
    renderer = createRenderer();
    await renderer.init(stage);
    api.run = render;
    api.readPixel = readPixel;
    api.compile = (frag) => compilePass({ id: 'test', frag }, renderer!.gl);
    api.display = (p) => canvasPxToDisplay(p, stage.width, stage.height, fitFor(lastInputs?.fitMode ?? 'cover', lastInputs?.videoWidth ?? 640, lastInputs?.videoHeight ?? 360, stage.width, stage.height));
    api.warmAll = async () => {
      const r = renderer!;
      const gl = r.gl!;
      const presets = Object.values(STYLE_PRESETS);
      const distinctPasses = new Set(presets.flatMap((p) => p.passes.map((pass) => pass.frag))).size;
      const programsBefore = r.getDebug()?.programs ?? 0;
      const warmBefore = presets.every((p) => r.isWarm(p));
      r.warm(presets);
      r.warm(presets); // idempotent: the second call must not duplicate work
      const pendingAfterCall = r.warmPending;
      for (let i = 0; i < 400 && r.warmPending > 0; i++) await new Promise((res) => setTimeout(res, 25));
      const allWarm = presets.every((p) => r.isWarm(p));
      return { programsBefore, programsAfter: r.getDebug()?.programs ?? 0, distinctPasses, warmBefore, allWarm, pendingAfterCall, glError: gl.getError() };
    };
    api.pump = async (frames) => {
      if (!lastInputs) throw new Error('nothing rendered yet');
      const r = renderer!;
      for (let i = 0; i < frames; i++) {
        // Separate tasks: timer-query results only become available in a later task than endQuery.
        await new Promise((res) => setTimeout(res, 16));
        r.render({ ...lastInputs, time: lastInputs.time + (i + 1) / 60 });
      }
      const extensionPresent = r.gl!.getExtension('EXT_disjoint_timer_query_webgl2') !== null;
      return { gpuMs: r.stats.gpuMs, gpuTimer: r.getDebug()?.gpuTimer ?? false, extensionPresent, passes: r.stats.passes };
    };
    api.rerenderOverlay = (dirty) => {
      if (!lastInputs || !lastSpec) throw new Error('nothing rendered yet');
      if (overlayCanvas) {
        if (dirty === undefined) delete overlayCanvas.__dirty;
        else overlayCanvas.__dirty = dirty;
      }
      renderer!.render({ ...lastInputs, time: lastInputs.time + 1 });
      return result(lastSpec);
    };
    api.loseAndRestore = async () => {
      if (!lastInputs || !lastSpec) throw new Error('nothing rendered yet');
      const gl = renderer!.gl!;
      const ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) throw new Error('WEBGL_lose_context unavailable');
      lostSeen = false;
      restoredSeen = false;
      ext.loseContext();
      await new Promise((res) => setTimeout(res, 50));
      // Rendering while lost must be a silent no-op.
      renderer!.render(lastInputs);
      const renderDuringLoss = result(lastSpec);
      ext.restoreContext();
      for (let i = 0; i < 100 && !restoredSeen; i++) await new Promise((res) => setTimeout(res, 20));
      return { lostSeen, restoredSeen, renderDuringLoss };
    };
    api.ready = true;
  } catch (e) {
    api.error = e instanceof Error ? e.message : String(e);
    api.ready = true;
  }
}

void main();
