import type { HudBox, HudCallout, HudCountdown, HudModel, HudTint, Size, TrackingFrame, Vec2 } from '@/types';
import { isHudModelExt, type HudModelExt } from './model';
import {
  BRACKET_SIZE_PX, COUNTDOWN_ALPHA, COUNTDOWN_LABELS, EDGE_PAD_PX, RECORD_DOT_PX, RING_LINE_PX, RING_START_ANGLE, TRACKING_EM,
  arcEndAngle, blinkOn, bracketSegments, clampToBounds, countdownLayout, countdownText, dwellRingRadiusPx, fpsBadgeText, hudFontPx,
  placeLabel, progressBucket, toPx, trackedWidth,
} from './layout';

/** Subset of CanvasRenderingContext2D the HUD uses (also satisfied by OffscreenCanvasRenderingContext2D and test fakes). */
export interface Hud2D {
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  clearRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fill(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

export type DebugDrawFn = (ctx: Hud2D, frame: TrackingFrame, size: Size) => void;

export interface DrawOptions {
  /** Disables the record-dot blink (prefers-reduced-motion / settings.reducedMotion). */
  reducedMotion: boolean;
  /** When true and a debug frame is on the model, `debugDraw` is invoked after the HUD. */
  debugLandmarks?: boolean;
  /** The interaction module's `drawLandmarks` (or any compatible function); nothing is drawn when absent. */
  debugDraw?: DebugDrawFn | undefined;
  /** Override font family (tests / harness). */
  fontFamily?: string;
}

export const HUD_COLORS: Record<HudTint, string> = { white: '#f5f5f7', red: '#ff2b2b' };
export const RECORD_RED = '#ff2b2b';
export const SHADOW_COLOR = 'rgba(0,0,0,.35)';
export const SHADOW_BLUR_PX = 2;
/** Inter first (bundled by the app shell), then platform UI faces so the HUD never falls back to a serif. */
export const HUD_FONT_STACK = 'Inter, "Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Snap to the pixel centre so 1 px strokes render crisp instead of a 2 px grey smear. */
const crisp = (v: number) => Math.round(v) + 0.5;

function applyShadow(ctx: Hud2D): void {
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = SHADOW_BLUR_PX;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1;
}

function fontString(px: number, family: string): string {
  return `300 ${px}px ${family}`;
}

/**
 * Draw `text` glyph by glyph with manual tracking. `x` is the left edge for
 * left alignment or the right edge for right alignment. Returns the drawn width.
 */
function fillTracked(ctx: Hud2D, text: string, x: number, y: number, tracking: number, align: 'left' | 'right'): number {
  const glyphs = Array.from(text);
  const widths = glyphs.map((g) => ctx.measureText(g).width);
  const total = trackedWidth(widths, tracking);
  let cx = align === 'left' ? x : x - total;
  ctx.textAlign = 'left';
  for (let i = 0; i < glyphs.length; i++) {
    ctx.fillText(glyphs[i] as string, cx, y);
    cx += (widths[i] as number) + tracking;
  }
  return total;
}

function measureTracked(ctx: Hud2D, text: string, tracking: number): number {
  return trackedWidth(Array.from(text).map((g) => ctx.measureText(g).width), tracking);
}

/** Tracked text centred horizontally on `cx` with its baseline at `y`. */
function fillTrackedCentred(ctx: Hud2D, text: string, cx: number, y: number, tracking: number): void {
  const width = measureTracked(ctx, text, tracking);
  fillTracked(ctx, text, cx - width / 2, y, tracking, 'left');
}

function drawLeader(ctx: Hud2D, from: Vec2, to: Vec2): void {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function drawBracket(ctx: Hud2D, anchorPx: Vec2, dir: 1 | -1): void {
  const a = { x: crisp(anchorPx.x), y: crisp(anchorPx.y) };
  const [h, v] = bracketSegments(a, dir, BRACKET_SIZE_PX);
  ctx.beginPath();
  ctx.moveTo(h.x1, h.y1);
  ctx.lineTo(h.x2, h.y2);
  ctx.moveTo(v.x1, v.y1);
  ctx.lineTo(v.x2, v.y2);
  ctx.stroke();
}

function drawBoxPx(ctx: Hud2D, centerPx: Vec2, w: number, h: number): void {
  ctx.strokeRect(centerPx.x - w / 2, centerPx.y - h / 2, w, h);
}

function drawCallout(ctx: Hud2D, c: HudCallout, size: Size, fontPx: number, tracking: number): void {
  const anchorPx = toPx(c.anchor, size);
  if (!Number.isFinite(anchorPx.x) || !Number.isFinite(anchorPx.y)) return;

  if (c.leaderTo) {
    const toPxPt = toPx(c.leaderTo, size);
    if (Number.isFinite(toPxPt.x) && Number.isFinite(toPxPt.y)) drawLeader(ctx, anchorPx, toPxPt);
  }
  if (c.box) drawBoxPx(ctx, anchorPx, c.box.w * size.width, c.box.h * size.height);

  const bracketAnchor = clampToBounds(anchorPx, size);
  if (c.code) {
    const width = measureTracked(ctx, c.code, tracking);
    const p = placeLabel(c.anchor, width, fontPx, size);
    fillTracked(ctx, c.code, p.x, p.y, tracking, p.align);
    if (c.bracket) drawBracket(ctx, bracketAnchor, p.align === 'left' ? 1 : -1);
  } else if (c.bracket) {
    drawBracket(ctx, bracketAnchor, 1);
  }
}

function drawFreeBox(ctx: Hud2D, b: HudBox, size: Size): void {
  const c = toPx(b.center, size);
  drawBoxPx(ctx, c, b.w * size.width, b.h * size.height);
}

/** Thin arc from 12 o'clock to the (quantized) progress; nothing for progress 0. */
function strokeProgressArc(ctx: Hud2D, center: Vec2, radius: number, progress: number): void {
  const a1 = arcEndAngle(progress);
  if (!(a1 > RING_START_ANGLE) || !(radius > 0)) return;
  ctx.lineWidth = RING_LINE_PX;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, RING_START_ANGLE, a1);
  ctx.stroke();
}

/**
 * 5 % bucket of the hold-still ring drawn for `model`, or 0 when no ring is drawn
 * (no progress, window faded out, or no corner callout to anchor it). Shared with
 * the redraw-dedupe key so the key and the drawing agree by construction.
 */
export function dwellRingBucket(model: HudModel): number {
  const p = model.dwellProgress;
  if (typeof p !== 'number' || !(p > 0) || !(model.opacity > 0)) return 0;
  if (!model.callouts.some((c) => c.id === 'corner')) return 0;
  return progressBucket(p);
}

/** Hold-still ring: thin arc around the corner callout anchor (14 px at 720p); follows the window opacity. */
function drawDwellRing(ctx: Hud2D, model: HudModel, size: Size): void {
  const corner = model.callouts.find((c) => c.id === 'corner');
  const p = model.dwellProgress;
  if (!corner || typeof p !== 'number') return;
  const anchorPx = toPx(corner.anchor, size);
  if (!Number.isFinite(anchorPx.x) || !Number.isFinite(anchorPx.y)) return;
  strokeProgressArc(ctx, anchorPx, dwellRingRadiusPx(size.height), p);
}

/**
 * Self-timer countdown: a centred numeral (18 % of the canvas height) with the
 * action label above it and a thin progress arc around it. Independent of the
 * window: drawn at a fixed alpha, static over time (no pulse, also under reduced motion).
 */
function drawCountdown(ctx: Hud2D, cd: HudCountdown, size: Size, family: string, color: string): void {
  const text = countdownText(cd.secondsLeft);
  if (!text) return;
  const l = countdownLayout(size);
  ctx.save();
  ctx.globalAlpha = COUNTDOWN_ALPHA;
  applyShadow(ctx);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.textBaseline = 'alphabetic';
  ctx.font = fontString(l.fontPx, family);
  fillTrackedCentred(ctx, text, l.center.x, l.baselineY, l.fontPx * TRACKING_EM);
  const label = COUNTDOWN_LABELS[cd.action];
  if (label) {
    ctx.font = fontString(l.labelFontPx, family);
    fillTrackedCentred(ctx, label, l.center.x, l.labelBaselineY, l.labelFontPx * TRACKING_EM);
  }
  strokeProgressArc(ctx, l.center, l.ringRadius, cd.progress);
  ctx.restore();
}

function drawRecordDot(ctx: Hud2D, size: Size, t: number, reducedMotion: boolean): void {
  if (!blinkOn(t, reducedMotion)) return;
  const r = RECORD_DOT_PX / 2;
  const margin = EDGE_PAD_PX + RECORD_DOT_PX + 6;
  ctx.save();
  ctx.globalAlpha = 1;
  applyShadow(ctx);
  ctx.fillStyle = RECORD_RED;
  ctx.beginPath();
  ctx.arc(size.width - margin, margin, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFpsBadge(ctx: Hud2D, fps: number, fontPx: number, tracking: number, family: string, tint: HudTint): void {
  ctx.save();
  ctx.globalAlpha = 1;
  applyShadow(ctx);
  ctx.font = fontString(fontPx, family);
  ctx.fillStyle = HUD_COLORS[tint];
  ctx.textBaseline = 'alphabetic';
  fillTracked(ctx, fpsBadgeText(fps), EDGE_PAD_PX + 8, EDGE_PAD_PX + 8 + fontPx * 0.75, tracking, 'left');
  ctx.restore();
}

/**
 * Render a HUD model into a 2D context sized `size` (device pixels).
 * Pure with respect to its inputs: identical (model, size, opts) ⇒ identical draw calls.
 * Draw order: callouts + boxes + dwell ring (window opacity) → countdown → record dot → fps badge → debug overlay.
 */
export function drawHud(ctx: Hud2D, model: HudModel | HudModelExt, size: Size, opts: DrawOptions): void {
  ctx.clearRect(0, 0, size.width, size.height);
  if (!(size.width > 0 && size.height > 0)) return;

  const family = opts.fontFamily ?? HUD_FONT_STACK;
  const fontPx = hudFontPx(size.height);
  const tracking = fontPx * TRACKING_EM;
  const color = HUD_COLORS[model.tint] ?? HUD_COLORS.white;
  const ext = isHudModelExt(model) ? model : null;
  const t = ext ? ext.t : (typeof performance !== 'undefined' ? performance.now() : 0);
  const boxes = model.boxes ?? [];

  const opacity = Math.min(1, Math.max(0, model.opacity));
  if (opacity > 0 && (model.callouts.length > 0 || boxes.length > 0)) {
    ctx.save();
    ctx.globalAlpha = opacity;
    applyShadow(ctx);
    ctx.font = fontString(fontPx, family);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.textBaseline = 'alphabetic';
    for (const c of model.callouts) drawCallout(ctx, c, size, fontPx, tracking);
    for (const b of boxes) drawFreeBox(ctx, b, size);
    if (dwellRingBucket(model) > 0) drawDwellRing(ctx, model, size);
    ctx.restore();
  }

  if (model.countdown) drawCountdown(ctx, model.countdown, size, family, color);
  if (model.recording) drawRecordDot(ctx, size, t, opts.reducedMotion);
  if (model.fps !== null && Number.isFinite(model.fps)) drawFpsBadge(ctx, model.fps, fontPx, tracking, family, model.tint);

  if (opts.debugLandmarks && opts.debugDraw && ext?.debugFrame) {
    ctx.save();
    ctx.globalAlpha = 1;
    opts.debugDraw(ctx, ext.debugFrame, size);
    ctx.restore();
  }
}
