/**
 * Frame pipeline (plan §2), all in VIDEO space at the internal resolution, then one cover-fit present:
 *
 *   raw video ──ingest(mirror)──▶ videoTex ──baseStyle passes──▶ baseTex ─┐
 *                                    └──windowStyle passes──▶ winTex ─────┼─▶ composite target
 *   quad (2 triangles, alpha = quad.opacity, glitch uv shift) samples winTex ⊕ personaOverlay ┘
 *   composite ──present(coverFit video→canvas, y flip)──▶ canvas, HUD composited at the same display uv
 *
 * Owns every GL object it creates; `dispose()` frees them. After a context loss the renderer simply
 * builds a new Compositor (see index.ts).
 */
import type { PassContext, QuadCorners, RenderInputs, StylePreset } from '@/types';
import { PERSONA_TOKENS } from '@/types';
import { coverFit, internalSize, quadToClipTriangles, TEXTURE_UNITS } from './fit';
import { PassRunner, ProgramCache, TargetPool, bindUnit, createSolidTexture, fullscreenTriangle, GlError, type RenderTarget } from './gl';
import { buildFragmentSource } from './prelude';
import { MaskTexture, SourceTexture, sourceReady, type UploadCounters } from './textures';
import { INGEST_FRAG, PRESENT_FRAG, QUAD_VERTEX, WINDOW_FRAG } from './shaders';

export interface CompositorDebug {
  uploads: UploadCounters;
  internalWidth: number;
  internalHeight: number;
  maskFormat: 'R32F' | 'R8';
  targets: number;
  /** Fit mapping used by the last present (canvas uv → display uv). */
  fit: { uvScale: [number, number]; uvOffset: [number, number] };
}

const EMPTY_PRESET: StylePreset = { id: 'comic', passes: [], usesBackdrop: false };

function hexToBytes(hex: string): [number, number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
}

export class Compositor {
  private readonly programs: ProgramCache;
  private readonly pool: TargetPool;
  private readonly triangle: { vao: WebGLVertexArrayObject; draw(): void };
  private readonly runner: PassRunner;
  private readonly rawVideo: SourceTexture;
  private readonly overlay: SourceTexture;
  private readonly backdrop: SourceTexture;
  private readonly hud: SourceTexture;
  private readonly mask: MaskTexture;
  private readonly transparent: WebGLTexture;
  private readonly paper: WebGLTexture;
  private readonly quadVao: WebGLVertexArrayObject;
  private readonly quadVbo: WebGLBuffer;
  private readonly quadData = new Float32Array(24);
  private internal = { width: 2, height: 2 };
  private lastTrackingT = Number.NaN;
  private passCount = 0;
  readonly debug: CompositorDebug;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.programs = new ProgramCache(gl);
    this.pool = new TargetPool(gl);
    this.triangle = fullscreenTriangle(gl);
    this.runner = new PassRunner(gl, this.programs, this.pool, this.triangle);
    this.rawVideo = new SourceTexture(gl, false);
    this.overlay = new SourceTexture(gl, true);
    this.backdrop = new SourceTexture(gl, true);
    this.hud = new SourceTexture(gl, true);
    this.mask = new MaskTexture(gl);
    this.transparent = createSolidTexture(gl, [0, 0, 0, 0]);
    this.paper = createSolidTexture(gl, hexToBytes(PERSONA_TOKENS.paperWhite));
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new GlError('quad VAO/VBO allocation failed');
    this.quadVao = vao;
    this.quadVbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.quadData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0); // a_clip
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8); // a_uv (display uv)
    gl.bindVertexArray(null);
    this.debug = {
      uploads: { video: 0, overlay: 0, mask: 0, skippedOverlay: 0 },
      internalWidth: 2,
      internalHeight: 2,
      maskFormat: this.mask.format,
      targets: 0,
      fit: { uvScale: [1, 1], uvOffset: [0, 0] },
    };
    // Warm the fixed programs so the first frame does not stall on compilation.
    this.programs.get(buildFragmentSource(INGEST_FRAG));
    this.programs.get(buildFragmentSource(PRESENT_FRAG));
    this.programs.get(buildFragmentSource(WINDOW_FRAG), QUAD_VERTEX);
  }

  /** Passes/draws issued by the last `render`. */
  get passes(): number {
    return this.passCount;
  }

  /** Clears the canvas to black (used when no frame can be drawn yet). */
  clear(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  render(inputs: RenderInputs): void {
    const gl = this.gl;
    this.runner.resetStats();
    this.passCount = 0;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);

    if (!sourceReady(inputs.video)) {
      this.clear();
      return;
    }
    const vw = inputs.videoWidth > 0 ? inputs.videoWidth : this.rawVideo.width;
    const vh = inputs.videoHeight > 0 ? inputs.videoHeight : this.rawVideo.height;

    // 1. Uploads -------------------------------------------------------------------------------
    if (this.rawVideo.upload(inputs.video, true)) this.debug.uploads.video++;
    const videoW = vw > 0 ? vw : this.rawVideo.width;
    const videoH = vh > 0 ? vh : this.rawVideo.height;
    const size = internalSize(videoW, videoH, inputs.quality.renderScale);
    if (size.width !== this.internal.width || size.height !== this.internal.height) {
      // Pool is keyed by size; a resolution change would otherwise leave stale targets alive.
      this.pool.dispose();
      this.internal = size;
      this.debug.internalWidth = size.width;
      this.debug.internalHeight = size.height;
    }
    const seg = inputs.tracking?.segmentation ?? null;
    const sameTracking = inputs.tracking !== null && inputs.tracking.t === this.lastTrackingT;
    if (this.mask.upload(seg, sameTracking)) this.debug.uploads.mask++;
    this.lastTrackingT = inputs.tracking?.t ?? Number.NaN;

    let backdropTex = this.paper;
    if (inputs.personaBackdrop && sourceReady(inputs.personaBackdrop)) {
      if (this.backdrop.upload(inputs.personaBackdrop)) this.debug.uploads.overlay++;
      else this.debug.uploads.skippedOverlay++;
      backdropTex = this.backdrop.texture;
    }
    let overlayTex = this.transparent;
    if (inputs.personaOverlay && sourceReady(inputs.personaOverlay)) {
      if (this.overlay.upload(inputs.personaOverlay)) this.debug.uploads.overlay++;
      else this.debug.uploads.skippedOverlay++;
      overlayTex = this.overlay.texture;
    }
    let hudTex = this.transparent;
    if (inputs.hudOverlay && sourceReady(inputs.hudOverlay)) {
      if (this.hud.upload(inputs.hudOverlay)) this.debug.uploads.overlay++;
      else this.debug.uploads.skippedOverlay++;
      hudTex = this.hud.texture;
    }

    const { width: W, height: H } = this.internal;
    const ctx: PassContext = { time: inputs.time, width: W, height: H, scene: inputs.scene, quality: inputs.quality };
    const passInputs = { video: this.rawVideo.texture, mask: this.mask.texture, backdrop: backdropTex };

    // 2. Ingest: raw video → display-space video (the ONLY place mirroring happens) --------------
    const videoTarget = this.pool.acquire(W, H);
    this.runner.drawPass({ id: 'ingest', frag: INGEST_FRAG }, this.rawVideo.texture, videoTarget, passInputs, inputs.time, {
      u_mirror: inputs.mirrored ? 1 : 0,
    });
    passInputs.video = videoTarget.texture;

    // 3. Base and window layers ------------------------------------------------------------------
    const base: RenderTarget | null = inputs.baseStyle && inputs.baseStyle.passes.length > 0
      ? this.runner.run(inputs.baseStyle.passes, videoTarget.texture, W, H, passInputs, ctx)
      : null;
    const baseTex = base ? base.texture : videoTarget.texture;

    const quad = inputs.quad;
    const showWindow = !!quad && quad.visible && quad.opacity > 0;
    let win: RenderTarget | null = null;
    if (showWindow) {
      const preset = inputs.windowStyle ?? EMPTY_PRESET;
      win = this.runner.run(preset.passes, videoTarget.texture, W, H, passInputs, ctx);
    }

    // 4. Composite: base, then the quad as two triangles with window content -----------------------
    const composite = this.pool.acquire(W, H);
    this.runner.drawPass({ id: 'composite-base', frag: PASSTHROUGH_FRAG }, baseTex, composite, passInputs, inputs.time);
    if (showWindow && win && quad) {
      this.drawQuad(quad.corners, quad.opacity, inputs.glitch, win.texture, overlayTex, composite, passInputs, inputs.time);
    }

    // 5. Present with ONE cover-fit mapping; HUD sampled through the same mapping -------------------
    const cw = gl.drawingBufferWidth;
    const ch = gl.drawingBufferHeight;
    const fit = coverFit(videoW, videoH, cw, ch);
    this.debug.fit = { uvScale: fit.uvScale, uvOffset: fit.uvOffset };
    bindUnit(gl, TEXTURE_UNITS.u_hud, hudTex);
    this.runner.drawPass({ id: 'present', frag: PRESENT_FRAG }, composite.texture, null, passInputs, inputs.time, {
      u_fitScale: fit.uvScale,
      u_fitOffset: fit.uvOffset,
    });

    this.pool.releaseAll();
    this.passCount = this.runner.passes;
    this.debug.targets = this.pool.size;
  }

  private drawQuad(
    corners: QuadCorners,
    opacity: number,
    glitch: number,
    windowTex: WebGLTexture,
    overlayTex: WebGLTexture,
    target: RenderTarget,
    passInputs: { video: WebGLTexture; mask: WebGLTexture; backdrop: WebGLTexture },
    time: number,
  ): void {
    const gl = this.gl;
    const prog = this.programs.get(buildFragmentSource(WINDOW_FRAG), QUAD_VERTEX);
    this.quadData.set(quadToClipTriangles(corners));
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(prog.program);
    bindUnit(gl, TEXTURE_UNITS.u_video, passInputs.video);
    bindUnit(gl, TEXTURE_UNITS.u_mask, passInputs.mask);
    bindUnit(gl, TEXTURE_UNITS.u_backdrop, passInputs.backdrop);
    bindUnit(gl, TEXTURE_UNITS.u_window, windowTex);
    bindUnit(gl, TEXTURE_UNITS.u_overlay, overlayTex);
    prog.uniforms.set2f('u_resolution', target.width, target.height);
    prog.uniforms.set2f('u_texel', 1 / target.width, 1 / target.height);
    prog.uniforms.set1f('u_time', time);
    prog.uniforms.set1f('u_opacity', Math.min(1, Math.max(0, opacity)));
    prog.uniforms.set1f('u_glitch', Math.min(1, Math.max(0, glitch || 0)));
    // Window alpha = quad.opacity; destination alpha stays opaque.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.quadData);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    this.runner.passes++;
  }

  dispose(): void {
    const gl = this.gl;
    this.pool.dispose();
    this.programs.dispose();
    this.rawVideo.dispose();
    this.overlay.dispose();
    this.backdrop.dispose();
    this.hud.dispose();
    this.mask.dispose();
    gl.deleteTexture(this.transparent);
    gl.deleteTexture(this.paper);
    gl.deleteVertexArray(this.quadVao);
    gl.deleteBuffer(this.quadVbo);
    gl.deleteVertexArray(this.triangle.vao);
  }
}

const PASSTHROUGH_FRAG = `void main() { fragColor = texture(u_color, v_uv); }`;
