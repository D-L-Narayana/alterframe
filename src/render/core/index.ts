/**
 * WebGL2 compositor entry point. `createRenderer()` implements `Renderer` (src/types/render.ts).
 *
 * Context: `premultipliedAlpha: false`, `preserveDrawingBuffer: true` (snapshots / captureStream),
 * `alpha: false`. Lost-context recovery: on `webglcontextlost` rendering is suspended; on
 * `webglcontextrestored` every GL object is rebuilt (programs, targets, textures, timer queries),
 * the next `render()` re-uploads all sources regardless of dirty flags, and presets warmed before
 * the loss are queued for warm-up again.
 */
import { DEFAULT_QUALITY, type RenderInputs, type Renderer, type StylePreset } from '@/types';
import { Compositor, type CompositorDebug } from './compositor';
import { backingSize } from './fit';
import { WarmQueue, pickIdleScheduler } from './warm';

export { compilePass, createProgram, createTexture, createFbo, fullscreenTriangle, PassRunner, ProgramCache, TargetPool, GlError } from './gl';
export type { CompileResult, RenderTarget, PassInputs, Program } from './gl';
export { FRAG_PRELUDE, VERTEX_SOURCE, PRELUDE_UNIFORMS, buildFragmentSource } from './prelude';
export { passthrough, solid, presetOf } from './passes';
export { coverFit, containFit, fitFor, fitContentRect, backingSize, internalSize, displayToClip, quadToClipTriangles, displayToCanvasPx, canvasPxToDisplay, TEXTURE_UNITS, TEXTURE_UNIT_ORDER } from './fit';
export type { CoverFit, FitMapping } from './fit';
export { WarmQueue, pickIdleScheduler } from './warm';
export type { IdleScheduler } from './warm';
export { GpuTimer } from './gpuTimer';
export { classifyUniform, UniformCache } from './uniforms';
export { chooseMaskFormat } from './textures';
export type { CompositorDebug } from './compositor';

/** Renderer plus compositor diagnostics (not part of the shared contract; safe to ignore). */
export interface CoreRenderer extends Renderer {
  /** True between `webglcontextlost` and `webglcontextrestored`. */
  readonly contextLost: boolean;
  /** Upload/pool/fit/program counters of the live compositor (null before init or while lost). */
  getDebug(): CompositorDebug | null;
  /** Times the context was lost (recovery test hook). */
  readonly contextLossCount: number;
  /** The WebGL2 context (null before init). */
  readonly gl: WebGL2RenderingContext | null;
  /**
   * Pre-compile the programs of these presets (contract `Renderer.warm`, always present here).
   * One preset per idle slot (`requestIdleCallback`, else `setTimeout(0)`, else synchronously).
   * Idempotent; a no-op before `init()` or while the context is lost.
   */
  warm(presets: readonly StylePreset[]): void;
  /** Presets still waiting for their warm-up slot. */
  readonly warmPending: number;
  /** True when every pass program of the preset is already compiled on the live context. */
  isWarm(preset: StylePreset): boolean;
}

export interface CreateRendererOptions {
  /** Override context attributes (tests use e.g. `{ antialias: false }`). */
  contextAttributes?: WebGLContextAttributes;
}

export function createRenderer(options: CreateRendererOptions = {}): CoreRenderer {
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let compositor: Compositor | null = null;
  let lost = false;
  let lossCount = 0;
  let disposed = false;
  let css = { width: 0, height: 0, dpr: 1 };
  let maxDpr = DEFAULT_QUALITY.maxDpr;
  const stats = { lastFrameMs: 0, passes: 0, gpuMs: null as number | null };
  let warmQueue: WarmQueue<StylePreset> | null = null;
  /** Every preset warmed on this renderer so far; re-warmed on a fresh compositor after a context restore. */
  const warmed: StylePreset[] = [];

  const warmOne = (preset: StylePreset): void => {
    if (!compositor || !gl || lost || disposed || gl.isContextLost()) return;
    compositor.warmPreset(preset);
  };
  const queue = (): WarmQueue<StylePreset> => {
    if (!warmQueue) {
      warmQueue = new WarmQueue<StylePreset>(warmOne, pickIdleScheduler(), (e, preset) => {
        console.warn(`[render] warm-up of preset "${preset.id}" failed:`, e instanceof Error ? e.message : e);
      });
    }
    return warmQueue;
  };

  const onLost = (e: Event): void => {
    // preventDefault tells the browser we intend to recover; a restored event will follow.
    e.preventDefault();
    lost = true;
    lossCount++;
    compositor = null; // GL objects are already invalid; nothing to delete.
    stats.gpuMs = null;
  };

  const onRestored = (): void => {
    if (!gl || disposed) return;
    lost = false;
    try {
      compositor = new Compositor(gl);
    } catch {
      compositor = null;
      return;
    }
    if (warmed.length > 0) queue().push(warmed);
  };

  function applyBackingSize(): void {
    if (!canvas || css.width <= 0 || css.height <= 0) return;
    const size = backingSize(css.width, css.height, css.dpr, maxDpr);
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
  }

  const renderer: CoreRenderer = {
    get canvas(): HTMLCanvasElement {
      if (!canvas) throw new Error('Renderer.init(canvas) has not been called');
      return canvas;
    },
    get stats() {
      return stats;
    },
    get contextLost() {
      return lost;
    },
    get contextLossCount() {
      return lossCount;
    },
    get gl() {
      return gl;
    },
    get warmPending() {
      return warmQueue?.pending ?? 0;
    },
    getDebug() {
      return compositor?.debug ?? null;
    },
    isWarm(preset: StylePreset): boolean {
      return !lost && (compositor?.isWarm(preset) ?? false);
    },

    async init(target: HTMLCanvasElement): Promise<void> {
      if (gl) throw new Error('Renderer already initialised');
      canvas = target;
      const attrs: WebGLContextAttributes = {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
        ...options.contextAttributes,
      };
      const ctx = target.getContext('webgl2', attrs);
      if (!ctx) throw new Error('WebGL2 is not supported by this browser/device');
      gl = ctx;
      target.addEventListener('webglcontextlost', onLost, false);
      target.addEventListener('webglcontextrestored', onRestored, false);
      compositor = new Compositor(gl);
      if (css.width > 0) applyBackingSize();
    },

    resize(cssWidth: number, cssHeight: number, dpr: number): void {
      css = { width: cssWidth, height: cssHeight, dpr: dpr > 0 ? dpr : 1 };
      applyBackingSize();
    },

    warm(presets: readonly StylePreset[]): void {
      if (!gl || !compositor || lost || disposed || gl.isContextLost()) return;
      for (const p of presets) if (!warmed.includes(p)) warmed.push(p);
      queue().push(presets);
    },

    render(inputs: RenderInputs): void {
      if (!gl || !canvas || disposed) return;
      const t0 = performance.now();
      if (inputs.quality.maxDpr !== maxDpr) {
        maxDpr = inputs.quality.maxDpr;
        applyBackingSize();
      }
      if (lost || gl.isContextLost()) {
        stats.passes = 0;
        stats.gpuMs = null;
        stats.lastFrameMs = performance.now() - t0;
        return;
      }
      if (!compositor) {
        try {
          compositor = new Compositor(gl);
        } catch {
          return;
        }
      }
      compositor.render(inputs);
      stats.passes = compositor.passes;
      // GPU time of an earlier frame (timer queries resolve asynchronously); null without the extension.
      stats.gpuMs = compositor.gpuMs;
      // CPU-side timing only (no gl.finish): measures submission cost, not GPU completion.
      stats.lastFrameMs = performance.now() - t0;
    },

    dispose(): void {
      disposed = true;
      warmQueue?.dispose();
      warmQueue = null;
      if (canvas) {
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
      }
      if (compositor && gl && !gl.isContextLost()) compositor.dispose();
      compositor = null;
      gl = null;
      canvas = null;
      stats.gpuMs = null;
    },
  };
  return renderer;
}
