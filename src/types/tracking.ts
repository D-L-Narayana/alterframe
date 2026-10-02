import type { Vec2, Vec3, Rect } from './geometry';

/** Which side of the SCREEN the hand is on (not anatomical handedness). */
export type HandSide = 'left' | 'right';

/** MediaPipe hand landmark indices used by the product. */
export const HAND_LM = {
  WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_TIP: 12,
  RING_TIP: 16, PINKY_MCP: 17, PINKY_TIP: 20,
} as const;

/** MediaPipe face-mesh landmark indices used by the product. */
export const FACE_LM = {
  NOSE_TIP: 1, CHIN: 152, FOREHEAD: 10,
  LEFT_EYE_OUTER: 263, LEFT_EYE_INNER: 362, LEFT_EYE_TOP: 386, LEFT_EYE_BOTTOM: 374,
  RIGHT_EYE_OUTER: 33, RIGHT_EYE_INNER: 133, RIGHT_EYE_TOP: 159, RIGHT_EYE_BOTTOM: 145,
  LEFT_IRIS_CENTER: 473, RIGHT_IRIS_CENTER: 468,
  MOUTH_LEFT: 61, MOUTH_RIGHT: 291, UPPER_LIP: 13, LOWER_LIP: 14,
  LEFT_BROW_OUTER: 300, LEFT_BROW_INNER: 336, RIGHT_BROW_OUTER: 70, RIGHT_BROW_INNER: 107,
  LEFT_CHEEK: 425, RIGHT_CHEEK: 205,
} as const;

export interface HandTrack {
  side: HandSide;
  /** 21 landmarks, normalized display space, smoothed. */
  landmarks: Vec3[];
  /** Detection/tracking confidence 0..1. */
  score: number;
  /** Convenience copies of landmarks[8], [4], and mean of [0,5,9,13,17]. */
  indexTip: Vec2;
  thumbTip: Vec2;
  palmCenter: Vec2;
  /** Approximate hand size: distance wrist→middle MCP, normalized by frame height. */
  size: number;
}

export interface FaceTrack {
  /** 478 landmarks (468 mesh + 10 iris), normalized display space. */
  landmarks: Vec3[];
  /** ARKit-style blendshape name → 0..1 (e.g. eyeBlinkLeft, jawOpen, mouthSmileLeft). */
  blendshapes: Record<string, number>;
  /** 4x4 column-major facial transformation matrix, if available. */
  transform: Float32Array | null;
  /** Derived anchors (display space). "left/right" are the VIEWER's left/right on screen. */
  leftEye: Vec2;   // eye on screen-left
  rightEye: Vec2;  // eye on screen-right
  noseTip: Vec2;
  chin: Vec2;
  forehead: Vec2;
  faceBox: Rect;
  /** Head roll in radians (positive = clockwise on screen). */
  roll: number;
  /** Derived scalars 0..1 (from blendshapes, with fallbacks from landmarks). */
  eyeOpenLeft: number;
  eyeOpenRight: number;
  mouthOpen: number;
  smile: number;
}

export interface SegmentationResult {
  /** Mask resolution (typically 256x256 or source res). */
  width: number;
  height: number;
  /** Person confidence 0..1 per pixel, row-major, top-left origin, ALREADY mirrored to display space. */
  data: Float32Array;
  /** Optional GPU copy owned by the tracker (valid only until next update). */
  texture: WebGLTexture | null;
}

export interface TrackingTimings { handsMs: number; faceMs: number; segMs: number; totalMs: number }

export interface TrackingFrame {
  /** Timestamp (ms, performance.now() domain) of the video frame analysed. */
  t: number;
  /** Source video dimensions in pixels. */
  sourceWidth: number;
  sourceHeight: number;
  /** 0, 1 or 2 hands, sorted by palmCenter.x ascending (screen-left first). */
  hands: HandTrack[];
  face: FaceTrack | null;
  segmentation: SegmentationResult | null;
  timings: TrackingTimings;
}

export interface TrackerOptions {
  /** Base URL for model files (default '/models'). */
  modelBaseUrl?: string;
  /** Base URL for MediaPipe wasm (default '/wasm'). */
  wasmBaseUrl?: string;
  delegate?: 'GPU' | 'CPU';
  numHands?: 1 | 2;
  enableFace?: boolean;
  enableSegmentation?: boolean;
  /** Run segmentation every N frames (default 1). Adaptive quality may raise this. */
  segmentationStride?: number;
  /** Apply horizontal mirror to all outputs (default true, selfie view). */
  mirrored?: boolean;
  /** One-Euro smoothing parameters. */
  smoothing?: { minCutoff: number; beta: number; dCutoff: number };
}

export interface Tracker {
  init(): Promise<void>;
  /** Analyse one video frame. Must be cheap to call at display rate; may reuse the previous result if the frame is unchanged. */
  update(video: HTMLVideoElement | HTMLCanvasElement | ImageBitmap, t: number): TrackingFrame;
  setOptions(partial: Partial<TrackerOptions>): void;
  readonly ready: boolean;
  dispose(): void;
}
