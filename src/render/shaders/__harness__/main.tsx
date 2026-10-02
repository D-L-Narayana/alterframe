/**
 * W5 shader harness page. Renders every preset on the procedural test scene and exposes
 * `window.__shaderHarness` for the Playwright verification script (verify.mjs).
 * Run: `npx vite --port 6215` then open /src/render/shaders/__harness__/index.html
 */
import { STYLE_PRESETS, COMIC_BASE_PRESET } from '../../styles';
import { ALL_PASSES } from '../index';
import type { PassContext, StylePreset } from '../../../types/render';
import { DEFAULT_QUALITY } from '../../../types/render';
import type { PersonaId } from '../../../types/scene';
import { DEFAULT_SCENE } from '../../../types/scene';
import { PassRunner } from './runner';
import { makeBackdrop, makeMask, makeVideoFrame, makeWhiteMask, PROBES, SCENE_H, SCENE_W, type BackdropKind } from './testScene';

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
}

interface WindowStats { mean: [number, number, number]; std: number; lumaMean: number; darkFrac: number }

interface RenderResult {
  width: number;
  height: number;
  passes: number;
  gpuMs: number | null;
  cpuMs: number;
  probes: Record<string, WindowStats>;
  /** Column stats across the door edge at x = 0.25 ± 6 px for ink detection. */
  doorColumn: { edgeDark: number; nearbyDark: number };
}

interface HarnessApi {
  compileAll(): Array<{ id: string; ok: boolean; log: string }>;
  render(opts: RenderOptions): RenderResult;
  /** PNG data URL of the last render, for eyeballing from the script. */
  snapshot(): string;
}

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

function windowStats(px: { width: number; height: number; data: Uint8Array }, nx: number, ny: number, radius: number): WindowStats {
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
    const video = opts.noise !== undefined ? makeVideoFrame(SCENE_W, SCENE_H, opts.noise) : scene;
    runner.upload({ video, mask: opts.mask === 'white' ? whiteMask : mask, backdrop: backdrops[backdrop] });
    const ctx: PassContext = {
      time: opts.time ?? 1,
      width,
      height,
      scene: { ...DEFAULT_SCENE, persona, base: opts.preset === 'comic-base' ? 'comic' : 'live' },
      quality: { ...DEFAULT_QUALITY, renderScale },
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
    // Door edge: dark fraction in a 3-px band on the edge vs 10 px to the right (flat wall).
    const edge = windowStats(px, 0.25, 0.62, 2);
    const nearby = windowStats(px, 0.25 + 14 / px.width, 0.62, 2);
    return { width, height, passes: stats.passes, gpuMs: stats.gpuMs, cpuMs, probes, doorColumn: { edgeDark: edge.darkFrac, nearbyDark: nearby.darkFrac } };
  },
  snapshot() {
    return glCanvas.toDataURL('image/png');
  },
};
window.__shaderHarness = api;

// ---- visible page ---------------------------------------------------------------------
const root = document.getElementById('root');
if (!root) throw new Error('no root');

function tile(label: string, draw: () => void, source: HTMLCanvasElement = glCanvas): void {
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
}

const compile = api.compileAll();
const status = document.getElementById('status');
if (status) {
  const bad = compile.filter((c) => !c.ok);
  status.textContent = bad.length === 0 ? `All ${compile.length} passes compile.` : `FAILED: ${bad.map((b) => `${b.id}: ${b.log}`).join(' | ')}`;
  status.dataset['ok'] = String(bad.length === 0);
}

// Source previews.
tile('input video (procedural)', () => undefined, scene);
tile('input mask (256²)', () => undefined, mask);

tile('paper-portrait (persona portrait, paper backdrop)', () => api.render({ preset: 'paper-portrait' }));
tile('comic + backdrop (persona masked, night city)', () => api.render({ preset: 'comic', persona: 'masked' }));
tile('comic + backdrop (persona suit, warm paper)', () => api.render({ preset: 'comic', persona: 'suit' }));
tile('comic base (full frame, no backdrop)', () => api.render({ preset: 'comic-base' }));
tile('paper-portrait @ renderScale 0.5', () => api.render({ preset: 'paper-portrait', renderScale: 0.5 }));
for (const p of ALL_PASSES) {
  const paperChain = p.id.endsWith('-paper') || p.id === 'quantize-clean';
  tile(`pass: ${p.id}`, () => api.render({ preset: `pass:${p.id}`, persona: paperChain ? 'portrait' : 'masked' }));
}

let t = 0;
function animate(): void {
  t += 1 / 30;
  const first = root!.querySelectorAll('figure')[3]?.querySelector('canvas');
  if (first) {
    api.render({ preset: 'comic', persona: 'masked', time: t });
    first.getContext('2d')?.drawImage(glCanvas, 0, 0);
  }
  requestAnimationFrame(animate);
}
if (!new URLSearchParams(location.search).has('static')) requestAnimationFrame(animate);
