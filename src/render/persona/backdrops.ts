import type { Size } from '../../types';
import type { Ctx2D } from './canvas';
import { PERSONA_PALETTE, withAlpha, mixHex } from './palette';
import { mulberry32, range } from './random';

/*
 * Backdrops are OPAQUE paintings that replace the segmented background inside the hand
 * window (W5's passes sample them as u_backdrop). All art is procedural and original.
 */

// ───────────────────────────── portrait: paper ─────────────────────────────

/** Paper white with faint fibre grain: short, randomly oriented hairlines plus a soft vignette. */
export function drawPaperBackdrop(ctx: Ctx2D, size: Size, seed = 11): void {
  const { width: w, height: h } = size;
  const P = PERSONA_PALETTE.portrait;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = P.paper;
  ctx.fillRect(0, 0, w, h);

  // Fibre grain. Density scales with area so it reads the same at any resolution.
  const rnd = mulberry32(seed);
  const count = Math.round((w * h) / 900);
  const len = Math.max(4, Math.min(w, h) * 0.012);
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const x = rnd() * w, y = rnd() * h, a = rnd() * Math.PI, l = len * (0.4 + rnd());
    const dark = rnd() < 0.7;
    ctx.strokeStyle = dark ? withAlpha(P.ink, range(rnd, 0.025, 0.06)) : withAlpha(P.highlight, range(rnd, 0.3, 0.6));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  // Vignette keeps the window centre brightest, like a lit sheet.
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
  g.addColorStop(0, withAlpha(P.ink, 0));
  g.addColorStop(1, withAlpha(P.ink, 0.08));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ───────────────────────────── masked: night city ─────────────────────────────

export interface Building {
  /** Left edge, normalized [0,1) — the skyline tiles horizontally with period 1. */
  x: number;
  /** Width and height, normalized to canvas width / height. */
  w: number;
  h: number;
  /** Lit windows as (column,row) grid cells; unlit cells are left dark. */
  windows: Array<{ c: number; r: number; warm: boolean }>;
  cols: number;
  rows: number;
  /** Roof decoration: 0 none, 1 antenna, 2 stepped crown. */
  roof: 0 | 1 | 2;
}

export const SKYLINE = {
  /** Far layer: shorter, denser, slow. speed in normalized widths per second. */
  far: { count: 9, speed: 0.0035, hMin: 0.22, hMax: 0.5, wMin: 0.05, wMax: 0.1 },
  /** Near layer: taller, sparser, faster. */
  near: { count: 7, speed: 0.008, hMin: 0.35, hMax: 0.72, wMin: 0.06, wMax: 0.13 },
} as const;

/** Procedural skyscrapers for one parallax layer. Deterministic for a seed → stable between frames. */
export function generateSkyline(seed: number, layer: keyof typeof SKYLINE): Building[] {
  const cfg = SKYLINE[layer];
  const rnd = mulberry32(seed * 7919 + (layer === 'near' ? 17 : 0));
  const out: Building[] = [];
  // Evenly spaced slots with jitter so buildings do not pile up.
  for (let i = 0; i < cfg.count; i++) {
    const slot = i / cfg.count;
    const w = range(rnd, cfg.wMin, cfg.wMax);
    const x = (slot + range(rnd, 0, 1 / cfg.count - w * 0.5) + 1) % 1;
    const h = range(rnd, cfg.hMin, cfg.hMax);
    const cols = 2 + Math.floor(w * 40), rows = 3 + Math.floor(h * 22);
    const lit = range(rnd, 0.25, 0.55);
    const windows: Building['windows'] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (rnd() < lit) windows.push({ c, r, warm: rnd() < 0.3 });
    const roofRoll = rnd();
    out.push({ x, w, h, windows, cols, rows, roof: roofRoll < 0.3 ? 1 : roofRoll < 0.5 ? 2 : 0 });
  }
  return out;
}

/** Horizontal parallax offset (normalized widths) at time t (ms). Frozen under reduced motion. */
export function parallaxOffset(tMs: number, speed: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const o = (tMs / 1000) * speed;
  return o - Math.floor(o);
}

interface NeonStreak { x: number; w: number; top: number; bottom: number; blue: boolean; speed: number }

function generateStreaks(seed: number): NeonStreak[] {
  const rnd = mulberry32(seed * 104729 + 3);
  const out: NeonStreak[] = [];
  for (let i = 0; i < 9; i++) {
    out.push({ x: rnd(), w: range(rnd, 0.004, 0.012), top: range(rnd, 0.05, 0.4), bottom: range(rnd, 0.6, 0.95), blue: rnd() < 0.55, speed: range(rnd, 0.004, 0.01) });
  }
  return out;
}

const skylineCache = new Map<string, { far: Building[]; near: Building[]; streaks: NeonStreak[] }>();
function skyline(seed: number) {
  const k = String(seed);
  let s = skylineCache.get(k);
  if (!s) { s = { far: generateSkyline(seed, 'far'), near: generateSkyline(seed, 'near'), streaks: generateStreaks(seed) }; skylineCache.set(k, s); }
  return s;
}

function drawBuildingLayer(ctx: Ctx2D, size: Size, buildings: Building[], offset: number, horizon: number, body: string, glass: string, warm: string, winAlpha: number): void {
  const { width: w, height: h } = size;
  for (const b of buildings) {
    // tile: draw at every wrapped position that intersects the canvas
    for (const k of [-1, 0, 1]) {
      const x0 = (b.x + offset + k) * w;
      const bw = b.w * w;
      if (x0 > w || x0 + bw < 0) continue;
      const bh = b.h * h;
      const y0 = horizon - bh;
      ctx.fillStyle = body;
      ctx.fillRect(x0, y0, bw, bh);
      if (b.roof === 1) { ctx.fillRect(x0 + bw * 0.5 - 1, y0 - bh * 0.12, 2, bh * 0.12); }
      if (b.roof === 2) { ctx.fillRect(x0 + bw * 0.2, y0 - bh * 0.05, bw * 0.6, bh * 0.05); ctx.fillRect(x0 + bw * 0.35, y0 - bh * 0.09, bw * 0.3, bh * 0.04); }
      // windows
      const cw = bw / b.cols, rh = bh / b.rows;
      const ww = Math.max(1, cw * 0.45), wh = Math.max(1, rh * 0.5);
      for (const win of b.windows) {
        ctx.fillStyle = win.warm ? warm : glass;
        ctx.globalAlpha = winAlpha;
        ctx.fillRect(x0 + win.c * cw + cw * 0.28, y0 + win.r * rh + rh * 0.25, ww, wh);
      }
      ctx.globalAlpha = 1;
    }
  }
}

type LayerCanvas = OffscreenCanvas | HTMLCanvasElement;

/** Creates a scratch canvas on whatever canvas kind the environment offers (null in Node). */
function makeCanvas(w: number, h: number): LayerCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return null;
}

interface CityLayers { key: string; sky: LayerCanvas; far: LayerCanvas; streaks: LayerCanvas; near: LayerCanvas; ground: LayerCanvas }
let cityLayers: CityLayers | null = null;

function paintSky(ctx: Ctx2D, size: Size): void {
  const { width: w, height: h } = size;
  const M = PERSONA_PALETTE.masked;
  const horizon = h * 0.82;
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, M.sky);
  sky.addColorStop(0.55, mixHex(M.sky, M.neonA, 0.22));
  sky.addColorStop(0.82, mixHex(M.sky, M.neonB, 0.35));
  sky.addColorStop(1, mixHex(M.sky, M.shade, 0.5));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const haze = ctx.createRadialGradient(w * 0.5, horizon, 0, w * 0.5, horizon, w * 0.75);
  haze.addColorStop(0, withAlpha(M.neonB, 0.28));
  haze.addColorStop(1, withAlpha(M.neonB, 0));
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, w, h);
}

function paintStreaks(ctx: Ctx2D, size: Size, streaks: NeonStreak[], offset = 0): void {
  const { width: w, height: h } = size;
  const M = PERSONA_PALETTE.masked;
  for (const st of streaks) {
    for (const k of [-1, 0, 1]) {               // tile so the layer wraps seamlessly
      const x = (st.x + offset + k) * w;
      if (x < -w * 0.1 || x > w * 1.1) continue;
      const col = st.blue ? M.neonA : M.neonB;
      const y0 = st.top * h, y1 = st.bottom * h;
      const glow = ctx.createLinearGradient(x - st.w * w * 4, 0, x + st.w * w * 4, 0);
      glow.addColorStop(0, withAlpha(col, 0)); glow.addColorStop(0.5, withAlpha(col, 0.35)); glow.addColorStop(1, withAlpha(col, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(x - st.w * w * 4, y0, st.w * w * 8, y1 - y0);
      const core = ctx.createLinearGradient(0, y0, 0, y1);
      core.addColorStop(0, withAlpha(col, 0)); core.addColorStop(0.3, withAlpha(M.mask, 0.9)); core.addColorStop(0.7, withAlpha(col, 0.9)); core.addColorStop(1, withAlpha(col, 0));
      ctx.fillStyle = core;
      ctx.fillRect(x - st.w * w * 0.5, y0, st.w * w, y1 - y0);
    }
  }
}

function paintGround(ctx: Ctx2D, size: Size): void {
  const { width: w, height: h } = size;
  const M = PERSONA_PALETTE.masked;
  const horizon = h * 0.82;
  const ground = ctx.createLinearGradient(0, horizon, 0, h);
  ground.addColorStop(0, mixHex(M.sky, M.shade, 0.6));
  ground.addColorStop(0.3, mixHex(M.sky, M.neonB, 0.25));
  ground.addColorStop(1, mixHex(M.sky, M.shade, 0.7));
  ctx.fillStyle = ground;
  ctx.fillRect(0, horizon, w, h - horizon);
}

const FAR_STYLE = (M: typeof PERSONA_PALETTE.masked) => [mixHex(M.sky, M.neonA, 0.18), mixHex(M.neonA, M.mask, 0.3), mixHex(M.neonB, M.mask, 0.4), 0.55] as const;
const NEAR_STYLE = (M: typeof PERSONA_PALETTE.masked) => [mixHex(M.sky, M.shade, 0.45), mixHex(M.neonA, M.mask, 0.45), mixHex(M.neonB, M.mask, 0.5), 0.9] as const;

/** Builds (or reuses) the five prerendered city layers for this size/seed. */
function cityLayersFor(size: Size, seed: number): CityLayers | null {
  const key = `${size.width}x${size.height}|${seed}`;
  if (cityLayers && cityLayers.key === key) return cityLayers;
  const mk = () => makeCanvas(size.width, size.height);
  const sky = mk(), far = mk(), streaks = mk(), near = mk(), ground = mk();
  if (!sky || !far || !streaks || !near || !ground) return null;
  const s = skyline(seed);
  const M = PERSONA_PALETTE.masked;
  const horizon = size.height * 0.82;
  const ctxOf = (c: LayerCanvas) => c.getContext('2d') as Ctx2D;
  paintSky(ctxOf(sky), size);
  drawBuildingLayer(ctxOf(far), size, s.far, 0, horizon, ...FAR_STYLE(M));
  paintStreaks(ctxOf(streaks), size, s.streaks);
  drawBuildingLayer(ctxOf(near), size, s.near, 0, horizon, ...NEAR_STYLE(M));
  paintGround(ctxOf(ground), size);
  cityLayers = { key, sky, far, streaks, near, ground };
  return cityLayers;
}

/** Blit a tiled layer at a normalized horizontal offset (two draws cover the wrap seam). */
function blitWrapped(ctx: Ctx2D, layer: LayerCanvas, size: Size, offset: number): void {
  const dx = Math.round(offset * size.width);
  ctx.drawImage(layer as CanvasImageSource, dx, 0);
  ctx.drawImage(layer as CanvasImageSource, dx - size.width, 0);
}

/** Uniform drift speed for the neon streak layer (between far and near so it reads as mid-distance). */
const STREAK_SPEED = 0.0055;

/** Head-parallax gain per city layer: normalized widths of extra offset per unit of (faceX − 0.5). */
export const HEAD_PARALLAX = { near: 0.04, far: 0.02, streaks: 0.03 } as const;
export type CityLayer = keyof typeof HEAD_PARALLAX;

/**
 * Extra horizontal offset (normalized widths) of a city layer for the head at normalized x `faceX`
 * (face box centre): `(faceX − 0.5) × gain`, so the city slides against the head like a real window.
 * 0 at the centre, when there is no face (null) and under reduced motion (frozen).
 */
export function cityParallaxOffset(faceX: number | null, layer: CityLayer, reducedMotion: boolean): number {
  if (reducedMotion || faceX === null || !Number.isFinite(faceX)) return 0;
  return (faceX - 0.5) * HEAD_PARALLAX[layer];
}

const layerSpeed = (layer: CityLayer): number => (layer === 'streaks' ? STREAK_SPEED : SKYLINE[layer].speed);

/** Wrap into [0,1); the identity for values already in range (`o − 0`). */
const wrap01 = (o: number): number => o - Math.floor(o);

/**
 * Total offset of a city layer: time drift (`parallaxOffset`) plus head parallax, wrapped into
 * [0,1) so the two-blit seam cover keeps working for negative head offsets. With the head centred
 * (or absent) this is exactly `parallaxOffset(tMs, speed, reducedMotion)`.
 */
export function cityLayerOffset(tMs: number, layer: CityLayer, reducedMotion: boolean, faceX: number | null): number {
  return wrap01(parallaxOffset(tMs, layerSpeed(layer), reducedMotion) + cityParallaxOffset(faceX, layer, reducedMotion));
}

/**
 * Night city: navy sky → magenta horizon glow, two parallax skyline layers with lit windows,
 * vertical neon streaks (blue / magenta) with glow, and a dark reflective ground band.
 * Static layers are prerendered once per size; each tick is five drawImage blits (≈ sub-ms).
 * `faceX` (normalized face-box centre x, null = no face) adds the head parallax (`cityParallaxOffset`);
 * omitted or 0.5 it paints exactly the time-driven drift.
 */
export function drawCityBackdrop(ctx: Ctx2D, size: Size, tMs: number, reducedMotion: boolean, seed = 5, faceX: number | null = null): void {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const farOff = cityLayerOffset(tMs, 'far', reducedMotion, faceX);
  const streakOff = cityLayerOffset(tMs, 'streaks', reducedMotion, faceX);
  const nearOff = cityLayerOffset(tMs, 'near', reducedMotion, faceX);
  const layers = cityLayersFor(size, seed);
  if (layers) {
    ctx.drawImage(layers.sky as CanvasImageSource, 0, 0);
    blitWrapped(ctx, layers.far, size, farOff);
    blitWrapped(ctx, layers.streaks, size, streakOff);
    blitWrapped(ctx, layers.near, size, nearOff);
    ctx.drawImage(layers.ground as CanvasImageSource, 0, 0);
  } else {
    // No scratch canvases available (Node / exotic env): paint directly. The streaks keep their
    // static position here (as before) and only follow the head.
    const M = PERSONA_PALETTE.masked;
    const s = skyline(seed);
    const horizon = size.height * 0.82;
    paintSky(ctx, size);
    drawBuildingLayer(ctx, size, s.far, farOff, horizon, ...FAR_STYLE(M));
    paintStreaks(ctx, size, s.streaks, cityParallaxOffset(faceX, 'streaks', reducedMotion));
    drawBuildingLayer(ctx, size, s.near, nearOff, horizon, ...NEAR_STYLE(M));
    paintGround(ctx, size);
  }
  ctx.restore();
}

// ───────────────────────────── suit: warm paper + halftone ─────────────────────────────

/** Warm paper with a faint diagonal halftone dot lattice (drawn as a repeating pattern tile). */
export function drawWarmPaperBackdrop(ctx: Ctx2D, size: Size): void {
  const { width: w, height: h } = size;
  const S = PERSONA_PALETTE.suit;
  const warm = mixHex(S.paper, S.pink, 0.035);
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, w, h);

  // Diagonal lattice: cell 12 px (scaled by resolution), dots at (¼,¼) and (¾,¾) of the tile.
  const cell = Math.max(8, Math.round(Math.min(w, h) / 60));
  const tile = makeTile(cell);
  if (tile) {
    const pat = ctx.createPattern(tile, 'repeat');
    if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, w, h); }
  }
  // Soft warm vignette
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
  g.addColorStop(0, withAlpha(S.pink, 0));
  g.addColorStop(1, withAlpha(S.pink, 0.1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Builds the halftone tile on the same canvas kind as `ctx` (OffscreenCanvas or <canvas>). */
function makeTile(cell: number): CanvasImageSource | null {
  let tile: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') tile = new OffscreenCanvas(cell, cell);
  else if (typeof document !== 'undefined') { tile = document.createElement('canvas'); tile.width = cell; tile.height = cell; }
  else return null;
  const t = tile.getContext('2d') as Ctx2D | null;
  if (!t) return null;
  const r = Math.max(0.8, cell * 0.11);
  t.fillStyle = withAlpha(PERSONA_PALETTE.suit.halftone, 0.13);
  for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.75]] as const) {
    t.beginPath(); t.arc(cell * fx, cell * fy, r, 0, Math.PI * 2); t.fill();
  }
  return tile;
}
