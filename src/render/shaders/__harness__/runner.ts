/**
 * Standalone WebGL2 pass runner for the shader harness. Implements exactly the StylePass
 * contract from src/types/render.ts (prelude, samplers, u_resolution/u_texel/u_time,
 * ping-pong FBOs sized by `pass.scale`) so the shaders can be compiled and pixel-tested
 * independently of the app's compositor (`src/render/core`). Never imported by the app.
 *
 * Orientation convention used here: textures are uploaded without UNPACK_FLIP_Y, so
 * texture row 0 (t = 0) is the top of the image and `v_uv.y = 0` is display-top in every
 * pass. FBO read-backs therefore come out top-row-first; the present step flips.
 */
import type { PassContext, StylePass, StylePreset, UniformValue } from '../../../types/render';
import { PRELUDE } from '../glsl';

const VERT = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // Fullscreen triangle: ids 0,1,2 → (-1,-1) (3,-1) (-1,3)
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_color;
out vec4 fragColor;
void main() { fragColor = vec4(texture(u_color, vec2(v_uv.x, 1.0 - v_uv.y)).rgb, 1.0); }
`;

export interface CompileResult { ok: boolean; log: string }

interface Target { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }

export interface RunnerInputs {
  video: TexImageSource;
  mask: TexImageSource;
  backdrop: TexImageSource;
}

export interface RunStats { passes: number; gpuMs: number | null }

export class PassRunner {
  private readonly programs = new Map<string, WebGLProgram>();
  private readonly targets: Target[] = [];
  private readonly texVideo: WebGLTexture;
  private readonly texMask: WebGLTexture;
  private readonly texBackdrop: WebGLTexture;
  private readonly present: WebGLProgram;
  private readonly timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private lastOutput: Target | null = null;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.texVideo = this.createTexture();
    this.texMask = this.createTexture();
    this.texBackdrop = this.createTexture();
    this.present = this.link(VERT, PRESENT_FRAG);
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') as PassRunner['timerExt'];
  }

  /** Compile a pass with the contract prelude; returns {ok, log} like the core's compilePass. */
  compilePass(pass: StylePass): CompileResult {
    const gl = this.gl;
    const sh = gl.createShader(gl.FRAGMENT_SHADER);
    if (!sh) return { ok: false, log: 'createShader failed' };
    gl.shaderSource(sh, PRELUDE + pass.frag);
    gl.compileShader(sh);
    const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean;
    const log = gl.getShaderInfoLog(sh) ?? '';
    if (ok) {
      // Also link, which catches errors the compile stage alone does not report.
      try {
        const prog = this.link(VERT, PRELUDE + pass.frag);
        this.programs.set(pass.id, prog);
      } catch (e) {
        gl.deleteShader(sh);
        return { ok: false, log: `link: ${(e as Error).message}` };
      }
    }
    gl.deleteShader(sh);
    return { ok, log };
  }

  upload(inputs: RunnerInputs): void {
    this.uploadTo(this.texVideo, inputs.video);
    this.uploadTo(this.texMask, inputs.mask);
    this.uploadTo(this.texBackdrop, inputs.backdrop);
  }

  /** Runs a preset at `width×height`; result stays in an FBO for `readPixels`/`presentTo`. */
  run(preset: StylePreset, ctx: PassContext): RunStats {
    const gl = this.gl;
    let query: WebGLQuery | null = null;
    if (this.timerExt) {
      query = gl.createQuery();
      if (query) gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, query);
    }
    let prev: WebGLTexture = this.texVideo;
    let out: Target | null = null;
    preset.passes.forEach((pass, i) => {
      const prog = this.programs.get(pass.id) ?? this.compileOrThrow(pass);
      const scale = pass.scale ?? 1;
      const w = Math.max(1, Math.round(ctx.width * scale));
      const h = Math.max(1, Math.round(ctx.height * scale));
      const target = this.target(i, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog);
      this.bindSampler(prog, 'u_color', 0, prev);
      this.bindSampler(prog, 'u_video', 1, this.texVideo);
      this.bindSampler(prog, 'u_mask', 2, this.texMask);
      this.bindSampler(prog, 'u_backdrop', 3, this.texBackdrop);
      gl.uniform2f(gl.getUniformLocation(prog, 'u_resolution'), w, h);
      gl.uniform2f(gl.getUniformLocation(prog, 'u_texel'), 1 / w, 1 / h);
      gl.uniform1f(gl.getUniformLocation(prog, 'u_time'), ctx.time);
      // Same semantics as the core's pass runner: uniforms() sees the pass output size (and ctx.look).
      const extra = pass.uniforms ? pass.uniforms({ ...ctx, width: w, height: h }) : {};
      for (const [name, value] of Object.entries(extra)) this.setUniform(prog, name, value);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      prev = target.tex;
      out = target;
    });
    this.lastOutput = out;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let gpuMs: number | null = null;
    if (query && this.timerExt) {
      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      // Timer results are async; we poll synchronously with a small spin (harness only).
      const start = performance.now();
      while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) && performance.now() - start < 200) { /* spin */ }
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        gpuMs = (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
      }
      gl.deleteQuery(query);
    }
    return { passes: preset.passes.length, gpuMs };
  }

  /** Read the last pass output. Row 0 = display top. */
  readPixels(): { width: number; height: number; data: Uint8Array } {
    const gl = this.gl;
    const t = this.lastOutput;
    if (!t) throw new Error('nothing rendered');
    const data = new Uint8Array(t.w * t.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: t.w, height: t.h, data };
  }

  /** Draw the last output to the default framebuffer (canvas), top side up. */
  presentTo(width: number, height: number): void {
    const gl = this.gl;
    const t = this.lastOutput;
    if (!t) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.present);
    this.bindSampler(this.present, 'u_color', 0, t.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---- internals -------------------------------------------------------------------

  private compileOrThrow(pass: StylePass): WebGLProgram {
    const r = this.compilePass(pass);
    if (!r.ok) throw new Error(`${pass.id}: ${r.log}`);
    const p = this.programs.get(pass.id);
    if (!p) throw new Error(`${pass.id}: program missing after compile`);
    return p;
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error('createShader failed');
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) ?? '';
        gl.deleteShader(sh);
        throw new Error(log);
      }
      return sh;
    };
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    const prog = gl.createProgram();
    if (!prog) throw new Error('createProgram failed');
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? '';
      gl.deleteProgram(prog);
      throw new Error(log);
    }
    return prog;
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private uploadTo(tex: WebGLTexture, src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  private target(index: number, w: number, h: number): Target {
    const gl = this.gl;
    const existing = this.targets[index];
    if (existing && existing.w === w && existing.h === h) return existing;
    if (existing) {
      gl.deleteFramebuffer(existing.fbo);
      gl.deleteTexture(existing.tex);
    }
    const tex = this.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('createFramebuffer failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`FBO incomplete: ${status}`);
    const t: Target = { fbo, tex, w, h };
    this.targets[index] = t;
    return t;
  }

  private bindSampler(prog: WebGLProgram, name: string, unit: number, tex: WebGLTexture): void {
    const gl = this.gl;
    const loc = gl.getUniformLocation(prog, name);
    if (!loc) return; // optimised out when unused — fine
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  private setUniform(prog: WebGLProgram, name: string, value: UniformValue): void {
    const gl = this.gl;
    const loc = gl.getUniformLocation(prog, name);
    if (!loc) return;
    if (typeof value === 'number') gl.uniform1f(loc, value);
    else if (value instanceof Float32Array) gl.uniform1fv(loc, value);
    else if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
    else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2]);
    else gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
  }
}
