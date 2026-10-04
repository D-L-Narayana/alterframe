/**
 * Shader harness page. Renders every preset on the procedural test scene and exposes
 * `window.__shaderHarness` for the Playwright verification script (verify.mjs).
 *
 * Run `node src/render/shaders/__harness__/run-verify.mjs` for the one-shot GPU check (starts
 * and stops the dev server itself), or `npx vite --port 6215` and open
 * /src/render/shaders/__harness__/index.html to eyeball the tiles; the Look sliders re-render
 * the first two preset tiles with the chosen `LookSettings` (defaults = the untuned render).
 */
import { STYLE_PRESETS, COMIC_BASE_PRESET } from '../../styles';
import { ALL_PASSES } from '../index';
import type { LookSettings, PassContext, StylePreset } from '../../../types/render';
import { DEFAULT_LOOK, DEFAULT_QUALITY } from '../../../types/render';
import type { PersonaId } from '../../../types/scene';
import { DEFAULT_SCENE } from '../../../types/scene';
import { PassRunner } from './runner';
import {
  makeBackdrop, makeMask, makeRamp, makeVideoFrame, makeWhiteMask, PROBES, SCENE_H, SCENE_W, type BackdropKind,
} from './testScene';

type PresetName = 'paper-portrait' | 'comic' | 'comic-base' | `pass:${string}`;

interface RenderOptions {
  preset: PresetName;
  persona?: PersonaId;
  backdrop?: BackdropKind;
  renderScale?: number;
  width?: number;
  height?: number;
  mask?: 'scene' | 'white';
  time?: number;
  noise?: number;
  /** 'room' (default) is the procedural scene; 'ramp' a horizontal grey ramp 0 → 1 with an all-white mask (band counting). */
  scene?: 'room' | 'ramp';
  /** Look overrides on top of DEFAULT_LOOK (absent = the untuned v0.1 render). */
  look?: Partial<LookSettings>;
}

interface WindowStats { mean: [number, number, number]; std: number; lumaMean: number; darkFrac: number }

interface RenderResult {
  width: number;
  height: number;
  passes: number;
  gpuMs: number | null;
  cpuMs: number;
  /** The look the passes actually saw. */
  look: LookSettings;
  probes: Record<string, WindowStats>;
  /**
   * Dark fractions across the door edge at x = 0.25: a 5-px window on the edge (`edgeDark`),
   * a 13-px window (`edgeDarkWide`, grows with the line width) and 14 px to the right on the
   * flat wall (`nearbyDark`).
   */
  doorColumn: { edgeDark: number; edgeDarkWide: number; nearbyDark: number };
  /** Fraction of dark pixels (luma < 0.25) over the whole output — rises with more / thicker lines. */
  frameDarkFrac: number;
  /** Distinct luma plateaus along the middle row: 8-bit luma bins holding ≥ 3 % of the row (= band count on the ramp). */
  rowLevels: number;
  /** FNV-1a hash of the output pixels: equal ⇔ bit-identical frames. */
  checksum: string;
}

interface HarnessApi {
  compileAll(): Array<{ id: string; ok: boolean; log: string }>;
  render(opts: RenderOptions): RenderResult;
  /** PNG data URL of the last render, for eyeballing from the script. */
  snapshot(): string;
}

interface Pixels { width: number; height: number; data: Uint8Array }

declare global {
  interface Window { __shaderHarness?: HarnessApi }
}

const glCanvas = document.createElement('canvas');
glCanvas.width = SCENE_W;
glCanvas.height = SCENE_H;
const gl = glCanvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
if (!gl) throw new Error('WebGL2 unavailable');
const runner = new PassRunner(gl);

const scene = makeVideoFrame();
const ramp = makeRamp();
const mask = makeMask();
const whiteMask = makeWhiteMask();
const backdrops: Record<BackdropKind, HTMLCanvasElement> = { paper: makeBackdrop('paper'), city: makeBackdrop('city'), warm: makeBackdrop('warm') };

function pickPreset(name: PresetName): StylePreset {
  if (name === 'comic-base') return COMIC_BASE_PRESET;
  if (name.startsWith('pass:')) {
    // Single-pass preview = the preset chain up to and including that pass, so each stage
    // is seen with the input it really gets.
    const id = name.slice(5);
    const chain = STYLE_PRESETS.comic.passes.some((p) => p.id === id) ? STYLE_PRESETS.comic : STYLE_PRESETS['paper-portrait'];
    const idx = chain.passes.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`unknown pass ${id}`);
    return { id: chain.id, usesBackdrop: true, passes: chain.passes.slice(0, idx + 1) };
  }
  return name === 'paper-portrait' ? STYLE_PRESETS['paper-portrait'] : STYLE_PRESETS.comic;
}

function luma(r: number, g: number, b: number): number { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

function windowStats(px: Pixels, nx: number, ny: number, radius: number): WindowStats {
  const cx = Math.round(nx * px.width);
  const cy = Math.round(ny * px.height);
  let n = 0; let sr = 0; let sg = 0; let sb = 0; let sl = 0; let sl2 = 0; let dark = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= px.width || y >= px.height) continue;
      const i = (y * px.width + x) * 4;
      const r = px.data[i] ?? 0; const g = px.data[i + 1] ?? 0; const b = px.data[i + 2] ?? 0;
      const l = luma(r, g, b);
      sr += r; sg += g; sb += b; sl += l; sl2 += l * l; n++;
      if (l < 0.25) dark++;
    }
  }
  const lm = sl / n;
  return { mean: [sr / n, sg / n, sb / n], std: Math.sqrt(Math.max(0, sl2 / n - lm * lm)), lumaMean: lm, darkFrac: dark / n };
}

function frameDarkFraction(px: Pixels): number {
  let dark = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    if (luma(px.data[i] ?? 0, px.data[i + 1] ?? 0, px.data[i + 2] ?? 0) < 0.25) dark++;
  }
  return dark / (px.width * px.height);
}

/**
 * Number of luma plateaus along the middle row: 8-bit bins that each cover ≥ `minFrac` of the
 * row, with adjacent qualifying bins merged (a plateau whose value sits on a rounding boundary,
 * e.g. 42.5/255 for 3 bands, still counts once). The soft band transitions spread over many
 * bins and never reach the threshold, so on a grey ramp this equals `u_bands`.
 */
function rowLevels(px: Pixels, minFrac = 0.03): number {
  const y = Math.floor(px.height / 2);
  const hist = new Uint32Array(256);
  for (let x = 0; x < px.width; x++) {
    const i = (y * px.width + x) * 4;
    const bin = Math.min(255, Math.max(0, Math.round(luma(px.data[i] ?? 0, px.data[i + 1] ?? 0, px.data[i + 2] ?? 0) * 255)));
    hist[bin] = (hist[bin] ?? 0) + 1;
  }
  const minCount = px.width * minFrac;
  let levels = 0;
  let previousQualified = false;
  for (let b = 0; b < 256; b++) {
    const qualified = (hist[b] ?? 0) >= minCount;
    if (qualified && !previousQualified) levels++;
    previousQualified = qualified;
  }
  return levels;
}

function checksum(px: Pixels): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < px.data.length; i++) {
    h ^= px.data[i] ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const api: HarnessApi = {
  compileAll() {
    return ALL_PASSES.map((p) => ({ id: p.id, ...runner.compilePass(p) }));
  },
  render(opts) {
    const persona = opts.persona ?? (opts.preset === 'paper-portrait' ? 'portrait' : 'masked');
    const backdrop = opts.backdrop ?? (persona === 'portrait' ? 'paper' : persona === 'masked' ? 'city' : 'warm');
    const renderScale = opts.renderScale ?? 1;
    const width = Math.round((opts.width ?? SCENE_W) * renderScale);
    const height = Math.round((opts.height ?? SCENE_H) * renderScale);
    const isRamp = opts.scene === 'ramp';
    const video = isRamp ? ramp : opts.noise !== undefined ? makeVideoFrame(SCENE_W, SCENE_H, opts.noise) : scene;
    runner.upload({ video, mask: isRamp || opts.mask === 'white' ? whiteMask : mask, backdrop: backdrops[backdrop] });
    const look: LookSettings = { ...DEFAULT_LOOK, ...(opts.look ?? {}) };
    const ctx: PassContext = {
      time: opts.time ?? 1,
      width,
      height,
      scene: { ...DEFAULT_SCENE, persona, base: opts.preset === 'comic-base' ? 'comic' : 'live' },
      quality: { ...DEFAULT_QUALITY, renderScale },
      look,
    };
    const t0 = performance.now();
    const stats = runner.run(pickPreset(opts.preset), ctx);
    gl.finish();
    const cpuMs = performance.now() - t0;
    const px = runner.readPixels();
    glCanvas.width = width;
    glCanvas.height = height;
    runner.presentTo(width, height);
    const probes: Record<string, WindowStats> = {};
    for (const p of PROBES) probes[p.name] = windowStats(px, p.x, p.y, 3);
    // Door edge: dark fraction in a 5-px / 13-px window on the edge vs 14 px to the right (flat wall).
    const edge = windowStats(px, 0.25, 0.62, 2);
    const edgeWide = windowStats(px, 0.25, 0.62, 6);
    const nearby = windowStats(px, 0.25 + 14 / px.width, 0.62, 2);
    return {
      width, height, passes: stats.passes, gpuMs: stats.gpuMs, cpuMs, look, probes,
      doorColumn: { edgeDark: edge.darkFrac, edgeDarkWide: edgeWide.darkFrac, nearbyDark: nearby.darkFrac },
      frameDarkFrac: frameDarkFraction(px),
      rowLevels: rowLevels(px),
      checksum: checksum(px),
    };
  },
  snapshot() {
    return glCanvas.toDataURL('image/png');
  },
};
window.__shaderHarness = api;

// ---- visible page ---------------------------------------------------------------------
const root = document.getElementById('root');
if (!root) throw new Error('no root');

function tile(label: string, draw: () => void, source: HTMLCanvasElement = glCanvas): HTMLCanvasElement {
  const fig = document.createElement('figure');
  const cap = document.createElement('figcaption');
  cap.textContent = label;
  const c = document.createElement('canvas');
  c.width = SCENE_W;
  c.height = SCENE_H;
  draw();
  const ctx = c.getContext('2d');
  if (ctx) ctx.drawImage(source, 0, 0, c.width, c.height);
  fig.append(c, cap);
  root!.append(fig);
  return c;
}

const compile = api.compileAll();
const status = document.getElementById('status');
if (status) {
  const bad = compile.filter((c) => !c.ok);
  status.textContent = bad.length === 0 ? `All ${compile.length} passes compile.` : `FAILED: ${bad.map((b) => `${b.id}: ${b.log}`).join(' | ')}`;
  status.dataset['ok'] = String(bad.length === 0);
}

// ---- look sliders (the shader knobs; overlayStrength belongs to the persona layer) -------
const liveLook: LookSettings = { ...DEFAULT_LOOK };
const LOOK_CONTROLS: ReadonlyArray<{ key: keyof LookSettings; label: string; min: number; max: number; step: number }> = [
  { key: 'inkWidth', label: 'Ink thickness ×', min: 0.25, max: 3, step: 0.05 },
  { key: 'inkThreshold', label: 'Ink threshold ×', min: 0.25, max: 3, step: 0.05 },
  { key: 'halftone', label: 'Halftone ×', min: 0, max: 2, step: 0.05 },
  { key: 'saturation', label: 'Saturation ×', min: 0, max: 2, step: 0.05 },
  { key: 'bands', label: 'Colour bands', min: 3, max: 8, step: 1 },
  { key: 'grain', label: 'Grain ×', min: 0, max: 3, step: 0.05 },
];
let onLookChange: () => void = () => undefined;
const lookForm = document.getElementById('look');
if (lookForm) {
  const outputs = new Map<keyof LookSettings, { input: HTMLInputElement; out: HTMLOutputElement }>();
  for (const c of LOOK_CONTROLS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(c.min);
    input.max = String(c.max);
    input.step = String(c.step);
    input.value = String(DEFAULT_LOOK[c.key]);
    input.name = c.key;
    const out = document.createElement('output');
    out.value = input.value;
    input.addEventListener('input', () => {
      liveLook[c.key] = Number(input.value);
      out.value = input.value;
      onLookChange();
    });
    label.append(c.label, input, out);
    lookForm.append(label);
    outputs.set(c.key, { input, out });
  }
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset look';
  reset.addEventListener('click', () => {
    Object.assign(liveLook, DEFAULT_LOOK);
    for (const [key, { input, out }] of outputs) {
      input.value = String(DEFAULT_LOOK[key]);
      out.value = input.value;
    }
    onLookChange();
  });
  lookForm.append(reset);
  const note = document.createElement('span');
  note.className = 'note';
  note.textContent = 'Overlay strength is applied by the persona layer (overlay alpha), not by a shader uniform, so it has no slider here.';
  lookForm.append(note);
}

// Source previews.
tile('input video (procedural)', () => undefined, scene);
tile('input mask (256²)', () => undefined, mask);

const ppTile = tile('paper-portrait (persona portrait, paper backdrop) — follows the Look sliders', () => api.render({ preset: 'paper-portrait', look: liveLook }));
const comicTile = tile('comic + backdrop (persona masked, night city) — follows the Look sliders, animated grain', () => api.render({ preset: 'comic', persona: 'masked', look: liveLook }));
tile('comic + backdrop (persona suit, warm paper)', () => api.render({ preset: 'comic', persona: 'suit' }));
tile('comic base (full frame, no backdrop)', () => api.render({ preset: 'comic-base' }));
tile('paper-portrait @ renderScale 0.5', () => api.render({ preset: 'paper-portrait', renderScale: 0.5 }));
tile('quantize-clean on a grey ramp (one plateau per band)', () => api.render({ preset: 'pass:quantize-clean', scene: 'ramp' }));
for (const p of ALL_PASSES) {
  const paperChain = p.id.endsWith('-paper') || p.id === 'quantize-clean';
  tile(`pass: ${p.id}`, () => api.render({ preset: `pass:${p.id}`, persona: paperChain ? 'portrait' : 'masked' }));
}

const isStatic = new URLSearchParams(location.search).has('static');
onLookChange = () => {
  api.render({ preset: 'paper-portrait', look: liveLook });
  ppTile.getContext('2d')?.drawImage(glCanvas, 0, 0);
  if (isStatic) {
    api.render({ preset: 'comic', persona: 'masked', look: liveLook });
    comicTile.getContext('2d')?.drawImage(glCanvas, 0, 0);
  }
};

let t = 0;
function animate(): void {
  t += 1 / 30;
  api.render({ preset: 'comic', persona: 'masked', time: t, look: liveLook });
  comicTile.getContext('2d')?.drawImage(glCanvas, 0, 0);
  requestAnimationFrame(animate);
}
if (!isStatic) requestAnimationFrame(animate);
