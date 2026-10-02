import type { TrackingFrame } from './tracking';
import type { WindowQuad } from './interaction';
import type { SceneState } from './scene';

export type UniformValue = number | [number, number] | [number, number, number] | [number, number, number, number] | Float32Array;

/**
 * A full-screen fragment pass. Vertex shader is supplied by the core.
 * Available in every fragment shader (declared by core prelude):
 *   in vec2 v_uv;                  // 0..1, (0,0)=top-left of DISPLAY space
 *   uniform sampler2D u_color;     // previous pass output (or video for the first pass)
 *   uniform sampler2D u_video;     // mirrored live video, display space
 *   uniform sampler2D u_mask;      // person confidence (r channel), display space
 *   uniform sampler2D u_backdrop;  // persona backdrop texture (W6), display space
 *   uniform vec2  u_resolution;    // pass output size in px
 *   uniform vec2  u_texel;         // 1/u_resolution
 *   uniform float u_time;          // seconds
 *   out vec4 fragColor;
 */
export interface StylePass {
  id: string;
  /** GLSL ES 3.00 fragment body WITHOUT #version/prelude (core prepends them). */
  frag: string;
  /** Extra uniforms resolved every frame. */
  uniforms?: (ctx: PassContext) => Record<string, UniformValue>;
  /** Render scale relative to output (e.g. 0.5 for blur passes). Default 1. */
  scale?: number;
}

export interface PassContext { time: number; width: number; height: number; scene: SceneState; quality: QualitySettings }

export type StyleId = 'paper-portrait' | 'comic';

export interface StylePreset {
  id: StyleId;
  passes: StylePass[];
  /** Whether this preset expects u_backdrop to replace background (mask<0.5). */
  usesBackdrop: boolean;
}

export interface QualitySettings {
  /** Internal render scale 0.5..1 of the canvas backing size. */
  renderScale: number;
  /** Max device pixel ratio honoured. */
  maxDpr: number;
  /** Segmentation stride (frames). */
  segmentationStride: number;
}

export const DEFAULT_QUALITY: QualitySettings = { renderScale: 1, maxDpr: 2, segmentationStride: 1 };

export interface RenderInputs {
  video: HTMLVideoElement | HTMLCanvasElement | ImageBitmap;
  videoWidth: number;
  videoHeight: number;
  mirrored: boolean;
  tracking: TrackingFrame | null;
  quad: WindowQuad | null;
  scene: SceneState;
  /** Stylization preset to apply to the BASE layer (null = live video). */
  baseStyle: StylePreset | null;
  /** Stylization preset used INSIDE the window. */
  windowStyle: StylePreset;
  /** RGBA overlay drawn by the persona layer (W6), display-space, same aspect as canvas. Composited inside the window only. */
  personaOverlay: HTMLCanvasElement | OffscreenCanvas | null;
  /** Backdrop texture source (W6) for background replacement inside the window. */
  personaBackdrop: HTMLCanvasElement | OffscreenCanvas | ImageBitmap | null;
  /** HUD overlay (W8), composited last over everything. */
  hudOverlay: HTMLCanvasElement | OffscreenCanvas | null;
  /** Thin-strip glitch intensity 0..1 (W7 derives from quad.thickness). */
  glitch: number;
  quality: QualitySettings;
  time: number;
}

export interface Renderer {
  init(canvas: HTMLCanvasElement): Promise<void>;
  /** Called on layout change; sizes in CSS px + dpr. Output uses object-fit: cover semantics. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  render(inputs: RenderInputs): void;
  /** The canvas containing the fully composited frame (base + window + persona + HUD). */
  readonly canvas: HTMLCanvasElement;
  readonly stats: { lastFrameMs: number; passes: number };
  dispose(): void;
}
