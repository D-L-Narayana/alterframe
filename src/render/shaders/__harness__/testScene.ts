/**
 * Procedural, original test scene for the shader harness (NOT a photo, nothing from the reel):
 * a warm room with a door edge, a poster and a lamp line; a person with dark hair, skin
 * ellipse, two eyes, lips and a grey hoodie; sensor-like noise. Also produces the matching
 * person mask, the three persona backdrops and a plain grey ramp (for counting quantisation
 * bands) as plain canvases.
 *
 * Probe points (normalized display coords) are exported so the verify script and the page
 * agree on what is "wall", "skin", "edge", etc.
 */
import { PERSONA_TOKENS } from '../../../types/persona';

export interface ProbePoint { name: string; x: number; y: number; region: 'background' | 'person' | 'edge' }

export const PROBES: readonly ProbePoint[] = [
  { name: 'wall-flat', x: 0.1, y: 0.18, region: 'background' },
  { name: 'wall-mid', x: 0.9, y: 0.6, region: 'background' },
  { name: 'door-edge', x: 0.25, y: 0.62, region: 'edge' },
  { name: 'skin-flat', x: 0.465, y: 0.48, region: 'person' },
  { name: 'hair', x: 0.5, y: 0.22, region: 'person' },
  { name: 'hoodie-flat', x: 0.5, y: 0.88, region: 'person' },
  { name: 'hair-skin-edge', x: 0.432, y: 0.45, region: 'edge' },
  { name: 'lips', x: 0.5, y: 0.555, region: 'person' },
];

export const SCENE_W = 640;
export const SCENE_H = 360;

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

/** Deterministic LCG so noise is identical between runs (stable pixel assertions). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Person silhouette shared by the video and the mask. */
function personPath(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.beginPath();
  // Head (ellipse) + neck + shoulders/torso down to the bottom edge.
  ctx.ellipse(0.5 * w, 0.42 * h, 0.085 * w, 0.2 * h, 0, 0, Math.PI * 2);
  ctx.rect(0.47 * w, 0.58 * h, 0.06 * w, 0.08 * h);
  ctx.moveTo(0.3 * w, 0.72 * h);
  ctx.bezierCurveTo(0.38 * w, 0.62 * h, 0.62 * w, 0.62 * h, 0.7 * w, 0.72 * h);
  ctx.lineTo(0.74 * w, h);
  ctx.lineTo(0.26 * w, h);
  ctx.closePath();
}

export function makeVideoFrame(w = SCENE_W, h = SCENE_H, noiseAmp = 0.04, seed = 7): HTMLCanvasElement {
  const c = canvas(w, h);
  const ctx = ctx2d(c);
  // Wall: warm gradient so there are mid-tones for the halftone.
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#e9dccb');
  g.addColorStop(1, '#a89a86');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Ceiling line.
  ctx.strokeStyle = '#cdbfae';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 0.12 * h);
  ctx.lineTo(w, 0.08 * h);
  ctx.stroke();
  // Door: dark panel with a frame edge at x = 0.25.
  ctx.fillStyle = '#4a4440';
  ctx.fillRect(0.05 * w, 0.2 * h, 0.2 * w, 0.8 * h);
  ctx.fillStyle = '#6e6560';
  ctx.fillRect(0.08 * w, 0.26 * h, 0.14 * w, 0.68 * h);
  // Poster on the right.
  ctx.fillStyle = '#f0ebe0';
  ctx.fillRect(0.72 * w, 0.2 * h, 0.12 * w, 0.16 * h);
  ctx.fillStyle = '#c84a3a';
  ctx.fillRect(0.75 * w, 0.24 * h, 0.06 * w, 0.08 * h);
  // Lamp arm.
  ctx.strokeStyle = '#2a2622';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0.98 * w, 0.1 * h);
  ctx.lineTo(0.86 * w, 0.14 * h);
  ctx.lineTo(0.86 * w, 0.4 * h);
  ctx.stroke();
  // Hoodie (torso).
  ctx.save();
  personPath(ctx, w, h);
  ctx.clip();
  ctx.fillStyle = '#7d8591';
  ctx.fillRect(0, 0.6 * h, w, 0.4 * h);
  ctx.restore();
  // Hair behind the face.
  ctx.fillStyle = '#1b1719';
  ctx.beginPath();
  ctx.ellipse(0.5 * w, 0.4 * h, 0.1 * w, 0.23 * h, 0, 0, Math.PI * 2);
  ctx.fill();
  // Face.
  ctx.fillStyle = '#e8b797';
  ctx.beginPath();
  ctx.ellipse(0.5 * w, 0.45 * h, 0.068 * w, 0.16 * h, 0, 0, Math.PI * 2);
  ctx.fill();
  // Fringe over the forehead down to y ≈ 0.3.
  ctx.fillStyle = '#1b1719';
  ctx.beginPath();
  ctx.ellipse(0.5 * w, 0.24 * h, 0.08 * w, 0.065 * h, 0, 0, Math.PI * 2);
  ctx.fill();
  // Eyes.
  for (const ex of [0.47, 0.53]) {
    ctx.fillStyle = '#fbf7f2';
    ctx.beginPath();
    ctx.ellipse(ex * w, 0.41 * h, 0.016 * w, 0.02 * h, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3a2314';
    ctx.beginPath();
    ctx.ellipse(ex * w, 0.412 * h, 0.008 * w, 0.015 * h, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Brows.
  ctx.strokeStyle = '#2a1a12';
  ctx.lineWidth = 3;
  for (const ex of [0.47, 0.53]) {
    ctx.beginPath();
    ctx.moveTo((ex - 0.018) * w, 0.37 * h);
    ctx.lineTo((ex + 0.018) * w, 0.365 * h);
    ctx.stroke();
  }
  // Nose shadow + lips.
  ctx.fillStyle = '#d49a7a';
  ctx.fillRect(0.497 * w, 0.46 * h, 0.006 * w, 0.03 * h);
  ctx.fillStyle = '#c23a4a';
  ctx.beginPath();
  ctx.ellipse(0.5 * w, 0.555 * h, 0.02 * w, 0.012 * h, 0, 0, Math.PI * 2);
  ctx.fill();
  // Sensor-like noise.
  if (noiseAmp > 0) {
    const img = ctx.getImageData(0, 0, w, h);
    const rnd = lcg(seed);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * 2 * noiseAmp * 255;
      d[i] = Math.max(0, Math.min(255, (d[i] ?? 0) + n));
      d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] ?? 0) + n));
      d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] ?? 0) + n));
    }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

/** Person mask: white on person, black elsewhere (r channel used). Low-res like the real one. */
export function makeMask(w = 256, h = 256): HTMLCanvasElement {
  const c = canvas(w, h);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  personPath(ctx, w, h);
  ctx.fill();
  // Hair extends above the person path; include it.
  ctx.beginPath();
  ctx.ellipse(0.5 * w, 0.4 * h, 0.1 * w, 0.23 * h, 0, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/**
 * Horizontal grey ramp, black at the left edge → white at the right edge, no noise. Run through
 * the quantise pass this yields one flat plateau per band, so the number of distinct luma
 * levels along a row equals `u_bands` (used by verify.mjs for the `look.bands` check).
 */
export function makeRamp(w = SCENE_W, h = SCENE_H): HTMLCanvasElement {
  const c = canvas(w, h);
  const ctx = ctx2d(c);
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#000000');
  g.addColorStop(1, '#ffffff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return c;
}

/** A blank, all-white mask (what the core should bind when segmentation is unavailable). */
export function makeWhiteMask(): HTMLCanvasElement {
  const c = canvas(2, 2);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 2, 2);
  return c;
}

export type BackdropKind = 'paper' | 'city' | 'warm';

export function makeBackdrop(kind: BackdropKind, w = SCENE_W, h = SCENE_H): HTMLCanvasElement {
  const c = canvas(w, h);
  const ctx = ctx2d(c);
  if (kind === 'paper' || kind === 'warm') {
    ctx.fillStyle = kind === 'paper' ? PERSONA_TOKENS.paperWhite : '#f3e6d6';
    ctx.fillRect(0, 0, w, h);
    const rnd = lcg(3);
    ctx.fillStyle = 'rgba(0,0,0,0.035)';
    for (let i = 0; i < 1500; i++) ctx.fillRect(rnd() * w, rnd() * h, 1, 1);
    return c;
  }
  // Night city.
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#060a1e');
  sky.addColorStop(1, PERSONA_TOKENS.nightNavy);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const rnd = lcg(11);
  for (let i = 0; i < 16; i++) {
    const bw = (0.04 + rnd() * 0.08) * w;
    const bx = i * (w / 16) + rnd() * 10;
    const bh = (0.3 + rnd() * 0.5) * h;
    ctx.fillStyle = '#10163a';
    ctx.fillRect(bx, h - bh, bw, bh);
    ctx.fillStyle = PERSONA_TOKENS.neonBlue;
    for (let y = h - bh + 6; y < h; y += 10) for (let x = bx + 3; x < bx + bw - 3; x += 7) if (rnd() > 0.5) ctx.fillRect(x, y, 3, 4);
    ctx.fillStyle = i % 3 === 0 ? PERSONA_TOKENS.neonMagenta : PERSONA_TOKENS.neonBlue;
    ctx.fillRect(bx + bw / 2 - 1, h - bh - 20, 2, bh + 20);
  }
  return c;
}
