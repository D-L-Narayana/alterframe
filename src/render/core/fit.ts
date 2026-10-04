/**
 * Pure geometry for the compositor: cover/contain fit mappings, backing-store sizing,
 * display→clip conversion and quad triangulation. No WebGL here (unit-testable in Node).
 *
 * COORDINATE CONVENTIONS (binding, see src/types/geometry.ts)
 * ------------------------------------------------------------
 * "Display space" = normalized [0,1], origin top-left, mirrored already applied. The tracker
 * emits it relative to the VIDEO frame, so display space == mirrored video-normalized space.
 *
 * Integration agreement: landmarks are normalized in the mirrored INTRINSIC VIDEO frame; the
 * persona overlay/backdrop and HUD canvases have the video frame's size/aspect; the whole pipeline
 * (video, mask, quad, overlays, HUD) is composited in that one video space and the compositor
 * applies a SINGLE fit transform (`fitFor(mode, video → canvas)`) in its present pass:
 *   - 'cover'   crops like `object-fit: cover` (the v0.1 behaviour and the default);
 *   - 'contain' letterboxes: the whole frame is shown, canvas pixels outside it are opaque black.
 * The canvas backing store is the CSS box × dpr (what the user sees is what gets recorded).
 * Nothing is mirrored twice (only the video sampling flips) and nothing is stretched.
 *
 * GL ORIENTATION
 * Intermediate FBO textures keep texel row 0 == display TOP (matches `texImage2D` of videos,
 * canvases and arrays with UNPACK_FLIP_Y = false). The fullscreen vertex shader therefore emits
 * `v_uv = clip * 0.5 + 0.5`, and `displayToClip` is the matching linear map (NO y flip).
 * The single y flip in the whole pipeline happens in the present pass, because the default
 * framebuffer shows clip y = +1 at the top of the screen.
 */
import type { FitMode, QuadCorners, Rect, Size, Vec2 } from '@/types';

/**
 * Mapping from canvas-normalized uv to display uv: `display = canvasUv * uvScale + uvOffset`.
 * Cover: uvScale ≤ 1, uvOffset ≥ 0 (a centred crop of the display frame fills the canvas).
 * Contain: uvScale ≥ 1, uvOffset ≤ 0 on the letterboxed axis (canvas rows/columns in the bars map
 * outside [0,1]; the present pass paints them black).
 */
export interface CoverFit {
  uvScale: [number, number];
  uvOffset: [number, number];
  /** Visible sub-rectangle of the display frame, normalized (what survives the crop; the whole frame for contain). */
  visible: Rect;
}

/** Same shape for either mode; `coverFit`, `containFit` and `fitFor` all return it. */
export type FitMapping = CoverFit;

const ASPECT_EPS = 1e-9;

function identityFit(): CoverFit {
  return { uvScale: [1, 1], uvOffset: [0, 0], visible: { x: 0, y: 0, w: 1, h: 1 } };
}

/**
 * object-fit: cover of a source of size (srcW,srcH) into a destination (dstW,dstH).
 * Returns the uv transform that, given a destination uv, yields the source uv to sample.
 */
export function coverFit(srcW: number, srcH: number, dstW: number, dstH: number): CoverFit {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return identityFit();
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (Math.abs(srcAspect - dstAspect) < ASPECT_EPS) return identityFit();
  if (dstAspect > srcAspect) {
    // Destination is wider: full source width is shown, source is cropped top/bottom.
    const sy = srcAspect / dstAspect;
    const oy = (1 - sy) / 2;
    return { uvScale: [1, sy], uvOffset: [0, oy], visible: { x: 0, y: oy, w: 1, h: sy } };
  }
  // Destination is taller: full source height is shown, source is cropped left/right.
  const sx = dstAspect / srcAspect;
  const ox = (1 - sx) / 2;
  return { uvScale: [sx, 1], uvOffset: [ox, 0], visible: { x: ox, y: 0, w: sx, h: 1 } };
}

/**
 * object-fit: contain (letterbox) of a source of size (srcW,srcH) into a destination (dstW,dstH).
 * The whole source stays visible, centred; on the letterboxed axis uvScale > 1 and uvOffset < 0, so
 * destination uv in the bars maps to source uv outside [0,1] (the present pass paints those black).
 */
export function containFit(srcW: number, srcH: number, dstW: number, dstH: number): CoverFit {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return identityFit();
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (Math.abs(srcAspect - dstAspect) < ASPECT_EPS) return identityFit();
  if (dstAspect > srcAspect) {
    // Destination is wider: full source height is shown, bars left and right (pillarbox).
    const sx = dstAspect / srcAspect;
    const ox = (1 - sx) / 2;
    return { uvScale: [sx, 1], uvOffset: [ox, 0], visible: { x: 0, y: 0, w: 1, h: 1 } };
  }
  // Destination is taller: full source width is shown, bars top and bottom (letterbox).
  const sy = srcAspect / dstAspect;
  const oy = (1 - sy) / 2;
  return { uvScale: [1, sy], uvOffset: [0, oy], visible: { x: 0, y: 0, w: 1, h: 1 } };
}

/** The present-pass mapping for a `FitMode` ('cover' is the default and the v0.1 behaviour). */
export function fitFor(mode: FitMode, srcW: number, srcH: number, dstW: number, dstH: number): CoverFit {
  return mode === 'contain' ? containFit(srcW, srcH, dstW, dstH) : coverFit(srcW, srcH, dstW, dstH);
}

/**
 * Canvas-normalized rectangle the display frame occupies under a fit (where display uv [0,1]²
 * lands). Inside [0,1]² for contain (the bars are its complement); spills outside for cover.
 */
export function fitContentRect(fit: CoverFit): Rect {
  const [sx, sy] = fit.uvScale;
  const [ox, oy] = fit.uvOffset;
  // `0 - ox` (not `-ox`) keeps a zero offset at +0 so identity fits compare equal to {0,0,1,1}.
  return { x: (0 - ox) / sx, y: (0 - oy) / sy, w: 1 / sx, h: 1 / sy };
}

/** Canvas backing-store size for a CSS box: css × min(dpr, maxDpr), never zero. */
export function backingSize(cssWidth: number, cssHeight: number, dpr: number, maxDpr: number): Size {
  const d = Math.max(0.5, Math.min(dpr || 1, maxDpr || 1));
  return { width: Math.max(1, Math.round(Math.max(1, cssWidth || 0) * d)), height: Math.max(1, Math.round(Math.max(1, cssHeight || 0) * d)) };
}

/**
 * Internal (video-space) working resolution: the video size scaled by renderScale, long side capped
 * so phones with 4K cameras do not pay full fill-rate. Even numbers for clean 0.5× passes.
 */
export function internalSize(videoWidth: number, videoHeight: number, renderScale: number, maxDimension = 1920): Size {
  if (!(videoWidth > 0 && videoHeight > 0)) return { width: 2, height: 2 };
  const scale = Math.min(1, Math.max(0.25, renderScale || 1));
  let w = videoWidth * scale;
  let h = videoHeight * scale;
  const long = Math.max(w, h);
  if (long > maxDimension) {
    const k = maxDimension / long;
    w *= k;
    h *= k;
  }
  return { width: even(w), height: even(h) };
}

function even(v: number): number {
  const r = Math.round(v);
  return Math.max(2, r % 2 === 0 ? r : r + 1);
}

/** Display (top-left origin, y down) → clip xy for intermediate targets (texel row 0 == display top). */
export function displayToClip(p: Vec2): [number, number] {
  return [p.x * 2 - 1, p.y * 2 - 1];
}

/**
 * Two triangles (TL,TR,BR) and (TL,BR,BL) as interleaved [clipX, clipY, u, v] × 6 vertices.
 * u,v are the display uv the window content is sampled at ("cut-out" semantics: the window
 * shows the hidden layer at the SAME screen coordinates). Bow-tie corner orders are rendered as-is.
 */
export function quadToClipTriangles(corners: QuadCorners): Float32Array {
  const order = [0, 1, 2, 0, 2, 3] as const;
  const out = new Float32Array(order.length * 4);
  order.forEach((ci, i) => {
    const c = corners[ci];
    const [cx, cy] = displayToClip(c);
    out[i * 4] = cx;
    out[i * 4 + 1] = cy;
    out[i * 4 + 2] = c.x;
    out[i * 4 + 3] = c.y;
  });
  return out;
}

/** Display point → canvas pixel (top-left origin) through a cover or contain fit mapping. */
export function displayToCanvasPx(p: Vec2, canvasW: number, canvasH: number, fit: CoverFit): Vec2 {
  const u = (p.x - fit.uvOffset[0]) / fit.uvScale[0];
  const v = (p.y - fit.uvOffset[1]) / fit.uvScale[1];
  return { x: u * canvasW, y: v * canvasH };
}

/** Canvas pixel → display point through a cover or contain fit mapping (outside [0,1] on the bars). */
export function canvasPxToDisplay(px: Vec2, canvasW: number, canvasH: number, fit: CoverFit): Vec2 {
  const u = px.x / canvasW;
  const v = px.y / canvasH;
  return { x: u * fit.uvScale[0] + fit.uvOffset[0], y: v * fit.uvScale[1] + fit.uvOffset[1] };
}

/**
 * Fixed texture-unit assignment. The first four match the contract prelude samplers in
 * declaration order; the rest are compositor-internal.
 */
export const TEXTURE_UNITS = {
  u_color: 0,
  u_video: 1,
  u_mask: 2,
  u_backdrop: 3,
  u_window: 4,
  u_overlay: 5,
  u_hud: 6,
} as const;

export type TextureUnitName = keyof typeof TEXTURE_UNITS;

export const TEXTURE_UNIT_ORDER: readonly TextureUnitName[] = (Object.keys(TEXTURE_UNITS) as TextureUnitName[]).sort(
  (a, b) => TEXTURE_UNITS[a] - TEXTURE_UNITS[b],
);
