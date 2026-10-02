/**
 * Thin WebGL2 helpers + the StylePass runner. Everything that owns GL objects is created through
 * `GlResources` so the renderer can throw it all away and rebuild after a context loss.
 */
import type { PassContext, StylePass, UniformValue } from '@/types';
import { FRAG_PRELUDE, VERTEX_SOURCE, buildFragmentSource } from './prelude';
import { UniformCache } from './uniforms';
import { TEXTURE_UNITS } from './fit';

export interface Program {
  program: WebGLProgram;
  uniforms: UniformCache;
}

export interface CompileResult {
  ok: boolean;
  /** Shader info log(s) joined; empty when ok and the driver had nothing to say. */
  log: string;
}

export interface RenderTarget {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

/** Thrown by helpers when GL refuses to create an object (usually a lost context). */
export class GlError extends Error {}

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): { shader: WebGLShader | null; log: string } {
  const shader = gl.createShader(type);
  if (!shader) return { shader: null, log: 'createShader returned null (context lost?)' };
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean;
  const log = gl.getShaderInfoLog(shader) ?? '';
  if (!ok && !gl.isContextLost()) {
    gl.deleteShader(shader);
    return { shader: null, log: log || 'compile failed without a log' };
  }
  return { shader, log };
}

/** Compile + link. Returns the linked program or a human-readable log. */
export function createProgram(gl: WebGL2RenderingContext, vertexSrc: string, fragmentSrc: string): { program: WebGLProgram | null; log: string } {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc);
  if (!vs.shader) return { program: null, log: `[vertex] ${vs.log}` };
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  if (!fs.shader) {
    gl.deleteShader(vs.shader);
    return { program: null, log: `[fragment] ${fs.log}` };
  }
  const program = gl.createProgram();
  if (!program) return { program: null, log: 'createProgram returned null' };
  gl.attachShader(program, vs.shader);
  gl.attachShader(program, fs.shader);
  gl.linkProgram(program);
  // Shaders can be flagged for deletion right away; they live on with the program.
  gl.deleteShader(vs.shader);
  gl.deleteShader(fs.shader);
  const linked = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
  const log = gl.getProgramInfoLog(program) ?? '';
  if (!linked && !gl.isContextLost()) {
    gl.deleteProgram(program);
    return { program: null, log: `[link] ${log}` };
  }
  return { program, log: [vs.log, fs.log, log].filter(Boolean).join('\n') };
}

export interface TextureOptions {
  /** gl.LINEAR (default) or gl.NEAREST. */
  filter?: number;
  /** gl.CLAMP_TO_EDGE default. */
  wrap?: number;
}

/** Allocates an empty texture with sane sampler state (clamp, no mips). */
export function createTexture(gl: WebGL2RenderingContext, opts: TextureOptions = {}): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new GlError('createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const filter = opts.filter ?? gl.LINEAR;
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return tex;
}

/** RGBA8 render target of the given size. */
export function createFbo(gl: WebGL2RenderingContext, width: number, height: number): RenderTarget {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const texture = createTexture(gl);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new GlError('createFramebuffer returned null');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    throw new GlError(`framebuffer incomplete: 0x${status.toString(16)}`);
  }
  return { fbo, texture, width: w, height: h };
}

export function deleteTarget(gl: WebGL2RenderingContext, t: RenderTarget): void {
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.texture);
}

/**
 * Fullscreen triangle: an empty VAO is enough because the vertex shader derives positions from
 * gl_VertexID. Returns a draw function.
 */
export function fullscreenTriangle(gl: WebGL2RenderingContext): { vao: WebGLVertexArrayObject; draw(): void } {
  const vao = gl.createVertexArray();
  if (!vao) throw new GlError('createVertexArray returned null');
  return {
    vao,
    draw() {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

/** 1×1 RGBA8 texture filled with a constant colour (bytes 0..255). */
export function createSolidTexture(gl: WebGL2RenderingContext, rgba: [number, number, number, number]): WebGLTexture {
  const tex = createTexture(gl);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
  return tex;
}

/**
 * Pool of RGBA8 render targets keyed by size. Targets survive across frames (no per-frame
 * allocation); `releaseAll()` at the end of a frame makes every target reusable.
 */
export class TargetPool {
  private readonly free = new Map<string, RenderTarget[]>();
  private readonly busy: RenderTarget[] = [];
  private readonly all: RenderTarget[] = [];

  constructor(private readonly gl: WebGL2RenderingContext) {}

  acquire(width: number, height: number): RenderTarget {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const key = `${w}x${h}`;
    const list = this.free.get(key);
    let t = list?.pop();
    if (!t) {
      t = createFbo(this.gl, w, h);
      this.all.push(t);
    }
    this.busy.push(t);
    return t;
  }

  release(t: RenderTarget): void {
    const i = this.busy.indexOf(t);
    if (i >= 0) this.busy.splice(i, 1);
    const key = `${t.width}x${t.height}`;
    const list = this.free.get(key);
    if (list) list.push(t);
    else this.free.set(key, [t]);
  }

  releaseAll(): void {
    while (this.busy.length) this.release(this.busy[this.busy.length - 1]!);
  }

  get size(): number {
    return this.all.length;
  }

  dispose(): void {
    for (const t of this.all) deleteTarget(this.gl, t);
    this.all.length = 0;
    this.busy.length = 0;
    this.free.clear();
  }
}

/** Compile-once cache of pass programs keyed by fragment source. */
export class ProgramCache {
  private readonly programs = new Map<string, Program>();

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /** Returns the program for a full fragment source (prelude included) or throws with the GL log. */
  get(fragmentSource: string, vertexSource: string = VERTEX_SOURCE): Program {
    const key = vertexSource === VERTEX_SOURCE ? fragmentSource : `${vertexSource}\u0000${fragmentSource}`;
    const hit = this.programs.get(key);
    if (hit) return hit;
    const { program, log } = createProgram(this.gl, vertexSource, fragmentSource);
    if (!program) throw new GlError(`shader build failed:\n${log}`);
    const built: Program = { program, uniforms: new UniformCache(this.gl, program) };
    // Bind the fixed sampler units once; they never change for this program.
    this.gl.useProgram(program);
    for (const [name, unit] of Object.entries(TEXTURE_UNITS)) built.uniforms.set1i(name, unit);
    this.programs.set(key, built);
    return built;
  }

  dispose(): void {
    for (const p of this.programs.values()) this.gl.deleteProgram(p.program);
    this.programs.clear();
  }
}

/**
 * Compile a StylePass (prelude + body) and report `{ ok, log }`. Exported for W5's tests.
 * Without an explicit context a hidden one is created lazily and shared.
 */
export function compilePass(pass: Pick<StylePass, 'frag' | 'id'>, gl?: WebGL2RenderingContext | null): CompileResult {
  const ctx = gl ?? sharedCompileContext();
  if (!ctx) return { ok: false, log: 'WebGL2 is not available in this environment' };
  let source: string;
  try {
    source = buildFragmentSource(pass.frag);
  } catch (e) {
    return { ok: false, log: (e as Error).message };
  }
  const { program, log } = createProgram(ctx, VERTEX_SOURCE, source);
  if (!program) return { ok: false, log: `${pass.id}: ${log}` };
  ctx.deleteProgram(program);
  return { ok: true, log };
}

let compileCtx: WebGL2RenderingContext | null | undefined;
function sharedCompileContext(): WebGL2RenderingContext | null {
  if (compileCtx !== undefined) return compileCtx;
  compileCtx = null;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    compileCtx = c.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
  }
  return compileCtx;
}

/** Textures the runner binds for every pass (the contract samplers). */
export interface PassInputs {
  video: WebGLTexture;
  mask: WebGLTexture;
  backdrop: WebGLTexture;
}

/**
 * Executes StylePass chains with ping-pong targets from the pool. `run` returns the final target,
 * which the caller must `release()` (or `releaseAll()`) when done sampling from it.
 */
export class PassRunner {
  /** Number of pass draws since the last `resetStats()`. */
  passes = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly programs: ProgramCache,
    private readonly pool: TargetPool,
    private readonly triangle: { draw(): void },
  ) {}

  resetStats(): void {
    this.passes = 0;
  }

  /**
   * Run `passes` starting from `input` (bound as u_color for the first pass) at the base size
   * `width×height` (pass.scale multiplies it). Returns the last output target.
   */
  run(passes: readonly StylePass[], input: WebGLTexture, width: number, height: number, inputs: PassInputs, ctx: PassContext): RenderTarget {
    let current = input;
    let currentTarget: RenderTarget | null = null;
    let out: RenderTarget | null = null;
    for (const pass of passes) {
      const scale = pass.scale && pass.scale > 0 ? pass.scale : 1;
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const target = this.pool.acquire(w, h);
      const extra = pass.uniforms ? pass.uniforms({ ...ctx, width: w, height: h }) : undefined;
      this.drawPass(pass, current, target, inputs, ctx.time, extra);
      if (currentTarget) this.pool.release(currentTarget);
      current = target.texture;
      currentTarget = target;
      out = target;
    }
    if (!out) {
      // Empty chain: materialise a copy so the caller always owns a target.
      out = this.pool.acquire(width, height);
      this.drawPass(PASSTHROUGH, input, out, inputs, ctx.time);
    }
    return out;
  }

  /** Draw one pass into `target` (or the default framebuffer when target is null). */
  drawPass(pass: Pick<StylePass, 'frag' | 'id'>, color: WebGLTexture, target: RenderTarget | null, inputs: PassInputs, time: number, extra?: Record<string, UniformValue>): void {
    const gl = this.gl;
    const prog = this.programs.get(buildFragmentSource(pass.frag));
    const w = target ? target.width : gl.drawingBufferWidth;
    const h = target ? target.height : gl.drawingBufferHeight;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(prog.program);
    bindUnit(gl, TEXTURE_UNITS.u_color, color);
    bindUnit(gl, TEXTURE_UNITS.u_video, inputs.video);
    bindUnit(gl, TEXTURE_UNITS.u_mask, inputs.mask);
    bindUnit(gl, TEXTURE_UNITS.u_backdrop, inputs.backdrop);
    prog.uniforms.set2f('u_resolution', w, h);
    prog.uniforms.set2f('u_texel', 1 / w, 1 / h);
    prog.uniforms.set1f('u_time', time);
    if (extra) for (const [name, value] of Object.entries(extra)) prog.uniforms.set(name, value);
    this.triangle.draw();
    this.passes++;
  }
}

const PASSTHROUGH = { id: 'passthrough', frag: `void main() { fragColor = texture(u_color, v_uv); }` };

export function bindUnit(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture | null): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}

export { FRAG_PRELUDE, VERTEX_SOURCE };
