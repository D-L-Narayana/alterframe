/**
 * Texture upload helpers: video / canvas sources with dirty-flag skipping, and the segmentation
 * mask (Float32Array → R32F, with an R8 fallback when float textures are not filterable).
 *
 * Orientation: all uploads keep UNPACK_FLIP_Y = false, so texel row 0 is the TOP row of the source.
 * Combined with the v_uv convention in fit.ts, no sampler needs a y flip. Mirroring is applied ONLY
 * to the video, in the ingest pass (compositor.ts) — the mask, overlays and HUD arrive already
 * mirrored in display space (W3/W6/W8).
 */
import type { DirtyCanvas, SegmentationResult } from '@/types';
import { createTexture } from './gl';

export type ImageSource = HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

export interface UploadCounters {
  video: number;
  overlay: number;
  mask: number;
  skippedOverlay: number;
}

function sourceSize(src: ImageSource): { w: number; h: number } {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  return { w: src.width, h: src.height };
}

/** Is the source currently decodable (video has data, canvas non-empty)? */
export function sourceReady(src: ImageSource): boolean {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) {
    return src.readyState >= 2 && src.videoWidth > 0 && src.videoHeight > 0;
  }
  return src.width > 0 && src.height > 0;
}

/**
 * An RGBA8 texture mirroring an image source. `upload()` re-uploads when forced, when the source
 * object or its size changed, or when the source's `__dirty` flag is true/absent (absent = upload
 * every frame, per contract). Setting `__dirty = false` after upload tells producers we consumed it.
 */
export class SourceTexture {
  readonly texture: WebGLTexture;
  width = 0;
  height = 0;
  private lastSource: ImageSource | null = null;
  private uploaded = false;

  constructor(private readonly gl: WebGL2RenderingContext, private readonly honourDirty: boolean) {
    this.texture = createTexture(gl);
  }

  /** Returns true when a GPU upload happened. */
  upload(src: ImageSource, force = false): boolean {
    const gl = this.gl;
    const { w, h } = sourceSize(src);
    if (!(w > 0 && h > 0)) return false;
    const changed = src !== this.lastSource || w !== this.width || h !== this.height || !this.uploaded;
    if (!changed && !force && this.honourDirty) {
      const dirty = (src as DirtyCanvas).__dirty;
      if (dirty === false) return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (changed) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    }
    this.width = w;
    this.height = h;
    this.lastSource = src;
    this.uploaded = true;
    if (this.honourDirty && typeof (src as DirtyCanvas).__dirty === 'boolean') (src as DirtyCanvas).__dirty = false;
    return true;
  }

  /** Forget the uploaded state (after context restore). */
  invalidate(): void {
    this.uploaded = false;
    this.width = 0;
    this.height = 0;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}

export type MaskFormat = 'R32F' | 'R8';

/** Pick the mask storage: R32F when it can be linearly filtered, else 8-bit (plenty for a 0..1 confidence). */
export function chooseMaskFormat(gl: WebGL2RenderingContext): MaskFormat {
  return gl.getExtension('OES_texture_float_linear') ? 'R32F' : 'R8';
}

/**
 * Person-confidence mask texture. Sampled in shaders via `.r`; both formats normalise to 0..1.
 * When no segmentation is available the texture is a 1×1 "all person" (1.0) so paper-portrait keeps colour.
 */
export class MaskTexture {
  readonly texture: WebGLTexture;
  readonly format: MaskFormat;
  width = 0;
  height = 0;
  private lastData: Float32Array | null = null;
  private bytes: Uint8Array | null = null;
  private isDefault = false;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.format = chooseMaskFormat(gl);
    this.texture = createTexture(gl, { filter: gl.LINEAR });
    this.setDefault();
  }

  private setDefault(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (this.format === 'R32F') gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([1]));
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    this.width = 1;
    this.height = 1;
    this.isDefault = true;
    this.lastData = null;
  }

  /**
   * Upload a segmentation result (top-left origin, already mirrored). Returns true when uploaded.
   * The same Float32Array instance with unchanged size is treated as "maybe updated" and re-uploaded
   * (trackers reuse their buffer), unless `sameFrame` says the tracker did not run this frame.
   */
  upload(seg: SegmentationResult | null, sameFrame = false): boolean {
    const gl = this.gl;
    if (!seg || !(seg.width > 0 && seg.height > 0) || seg.data.length < seg.width * seg.height) {
      if (!this.isDefault) this.setDefault();
      return false;
    }
    if (sameFrame && seg.data === this.lastData && seg.width === this.width && seg.height === this.height) return false;
    const resize = seg.width !== this.width || seg.height !== this.height || this.isDefault;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const n = seg.width * seg.height;
    if (this.format === 'R32F') {
      const view = seg.data.length === n ? seg.data : seg.data.subarray(0, n);
      if (resize) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, seg.width, seg.height, 0, gl.RED, gl.FLOAT, view);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, seg.width, seg.height, gl.RED, gl.FLOAT, view);
    } else {
      if (!this.bytes || this.bytes.length !== n) this.bytes = new Uint8Array(n);
      const b = this.bytes;
      const d = seg.data;
      for (let i = 0; i < n; i++) {
        const v = d[i] ?? 0;
        b[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
      }
      if (resize) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, seg.width, seg.height, 0, gl.RED, gl.UNSIGNED_BYTE, b);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, seg.width, seg.height, gl.RED, gl.UNSIGNED_BYTE, b);
    }
    this.width = seg.width;
    this.height = seg.height;
    this.isDefault = false;
    this.lastData = seg.data;
    return true;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
