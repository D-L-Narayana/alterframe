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
 *   uniform sampler2D u_backdrop;  // persona backdrop texture, display space
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

/**
 * How the video frame is presented in the canvas.
 *  - 'cover'   crops like `object-fit: cover` (default, what the user saw in v0.1);
 *  - 'contain' letterboxes: the whole frame is visible, the remaining canvas area is opaque black.
 * Overlays (persona, HUD) always follow the video through the same mapping; nothing is drawn on the bars.
 */
export type FitMode = 'cover' | 'contain';

/**
 * User-tunable look. Every field is a multiplier around the authored v0.1 constants, so
 * `DEFAULT_LOOK` reproduces the original render exactly:
 *   inkWidth       × the 2 px @720p ink line width
 *   inkThreshold   × the Sobel thresholds (u_edgeLo 0.2 / u_edgeHi 0.5); > 1 = fewer lines
 *   halftone       × the halftone darkening cap (u_maxDarken 0.25); 0 disables the dots
 *   saturation     × the cel chroma boost (1.25)
 *   bands          number of luminance bands in the quantise pass (3..8; default 6)
 *   grain          × the paper grain amplitude (0.03)
 *   overlayStrength 0..1 multiplier on the persona overlay alpha (lenses, suit, accents)
 */
export interface LookSettings {
  inkWidth: number;
  inkThreshold: number;
  halftone: number;
  saturation: number;
  bands: number;
  grain: number;
  overlayStrength: number;
}

export const DEFAULT_LOOK: LookSettings = { inkWidth: 1, inkThreshold: 1, halftone: 1, saturation: 1, bands: 6, grain: 1, overlayStrength: 1 };

/**
 * Per-pass context handed to `StylePass.uniforms`. `width`/`height` are the PASS OUTPUT size
 * (already multiplied by `pass.scale` and by `quality.renderScale`), not the canvas size.
 */
export interface PassContext { time: number; width: number; height: number; scene: SceneState; quality: QualitySettings; look: LookSettings }

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
  /**
   * Maximum height (px) of the frame handed to the tracking models. Taller frames are downscaled
   * once per analysed frame before inference; 720 = native for a 720p camera (no resampling).
   */
  inferenceMaxHeight: number;
  /** Run the face landmarker every N analysed frames (1 = every frame); the last face is reused in between. */
  faceStride: number;
}

export const DEFAULT_QUALITY: QualitySettings = { renderScale: 1, maxDpr: 2, segmentationStride: 1, inferenceMaxHeight: 720, faceStride: 1 };

export interface RenderInputs {
  video: HTMLVideoElement | HTMLCanvasElement | ImageBitmap;
  /** Intrinsic video size; defines display space (everything else is normalized to it). */
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
  /** RGBA overlay drawn by the persona layer, display-space, same aspect as the video. Composited inside the window only. */
  personaOverlay: HTMLCanvasElement | OffscreenCanvas | null;
  /** Backdrop texture source for background replacement inside the window. */
  personaBackdrop: HTMLCanvasElement | OffscreenCanvas | ImageBitmap | null;
  /** HUD overlay, composited last over everything. */
  hudOverlay: HTMLCanvasElement | OffscreenCanvas | null;
  /** Thin-strip glitch intensity 0..1 (derived from quad.thickness when the setting is on). */
  glitch: number;
  quality: QualitySettings;
  /** Presentation mapping video → canvas (see FitMode). */
  fitMode: FitMode;
  /** Look parameters forwarded to the passes (core substitutes DEFAULT_LOOK when absent). */
  look?: LookSettings;
  time: number;
}

export interface Renderer {
  init(canvas: HTMLCanvasElement): Promise<void>;
  /** Called on layout change; sizes in CSS px + dpr. Backing store = css × min(dpr, quality.maxDpr). */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  render(inputs: RenderInputs): void;
  /** The canvas containing the fully composited frame (base + window + persona + HUD). */
  readonly canvas: HTMLCanvasElement;
  /** `gpuMs` is the measured GPU time of the last frame when a timer-query extension exists, else null. */
  readonly stats: { lastFrameMs: number; passes: number; gpuMs: number | null };
  /** Pre-compile the programs of these presets so the first styled frame does not stall. Optional, idempotent. */
  warm?(presets: readonly StylePreset[]): void;
  dispose(): void;
}
