/**
 * W4 — WebGL2 compositor entry point. `createRenderer()` implements `Renderer` (src/types/render.ts).
 *
 * Context: `premultipliedAlpha: false`, `preserveDrawingBuffer: true` (snapshots / captureStream),
 * `alpha: false`. Lost-context recovery: on `webglcontextlost` rendering is suspended; on
 * `webglcontextrestored` every GL object is rebuilt (programs, targets, textures) and the next
 * `render()` re-uploads all sources regardless of dirty flags.
 */
import { DEFAULT_QUALITY, type RenderInputs, type Renderer } from '@/types';
import { Compositor, type CompositorDebug } from './compositor';
import { backingSize } from './fit';

export { compilePass, createProgram, createTexture, createFbo, fullscreenTriangle, PassRunner, ProgramCache, TargetPool, GlError } from './gl';
export type { CompileResult, RenderTarget, PassInputs, Program } from './gl';
export { FRAG_PRELUDE, VERTEX_SOURCE, PRELUDE_UNIFORMS, buildFragmentSource } from './prelude';
export { passthrough, solid, presetOf } from './passes';
export { coverFit, backingSize, internalSize, displayToClip, quadToClipTriangles, displayToCanvasPx, canvasPxToDisplay, TEXTURE_UNITS, TEXTURE_UNIT_ORDER } from './fit';
export type { CoverFit } from './fit';
export { classifyUniform, UniformCache } from './uniforms';
export { chooseMaskFormat } from './textures';
export type { CompositorDebug } from './compositor';

/** Renderer plus W4 diagnostics (not part of the shared contract; safe to ignore). */
export interface CoreRenderer extends Renderer {
  /** True between `webglcontextlost` and `webglcontextrestored`. */
  readonly contextLost: boolean;
  /** Upload/pool/fit counters of the live compositor (null before init or while lost). */
  getDebug(): CompositorDebug | null;
  /** Times the context was lost (recovery test hook). */
  readonly contextLossCount: number;
  /** The WebGL2 context (null before init). */
  readonly gl: WebGL2RenderingContext | null;
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
  const stats = { lastFrameMs: 0, passes: 0 };

  const onLost = (e: Event): void => {
    // preventDefault tells the browser we intend to recover; a restored event will follow.
    e.preventDefault();
    lost = true;
    lossCount++;
    compositor = null; // GL objects are already invalid; nothing to delete.
  };

  const onRestored = (): void => {
    if (!gl || disposed) return;
    lost = false;
    try {
      compositor = new Compositor(gl);
    } catch {
      compositor = null;
    }
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
    getDebug() {
      return compositor?.debug ?? null;
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

    render(inputs: RenderInputs): void {
      if (!gl || !canvas || disposed) return;
      const t0 = performance.now();
      if (inputs.quality.maxDpr !== maxDpr) {
        maxDpr = inputs.quality.maxDpr;
        applyBackingSize();
      }
      if (lost || gl.isContextLost()) {
        stats.passes = 0;
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
      // CPU-side timing only (no gl.finish): measures submission cost, not GPU completion.
      stats.lastFrameMs = performance.now() - t0;
    },

    dispose(): void {
      disposed = true;
      if (canvas) {
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
      }
      if (compositor && gl && !gl.isContextLost()) compositor.dispose();
      compositor = null;
      gl = null;
      canvas = null;
    },
  };
  return renderer;
}
