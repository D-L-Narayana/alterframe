/**
 * Visual dev harness for the compositor (not wired into the app).
 * `npx vite --port 5176 --open /src/render/core/__harness__/index.html`
 *
 * A generated test "video" (2D canvas: moving gradient, grid and a dark head-like disc) is fed
 * through the renderer with: a live or solid-tinted base, a procedural "poster" window style,
 * an animated quad whose thickness breathes (glitch follows 1 - thickness/0.04), a persona overlay
 * canvas (dot that tracks the disc) and a HUD canvas (fps + crosshair) — all in video space.
 * The "display" select switches the present fit between Fill (cover) and Fit (contain, black bars);
 * the info line shows the GPU frame time when the timer-query extension exists.
 */
import type { FitMode, QuadCorners, RenderInputs, StylePass, WindowQuad } from '@/types';
import { DEFAULT_QUALITY, DEFAULT_SCENE, PERSONA_TOKENS } from '@/types';
import { createRenderer, presetOf, solid } from '../index';

const VW = 640;
const VH = 360;

const video = document.createElement('canvas');
video.width = VW;
video.height = VH;
const vctx = video.getContext('2d')!;

const overlay = document.createElement('canvas') as HTMLCanvasElement & { __dirty?: boolean };
overlay.width = VW;
overlay.height = VH;
const octx = overlay.getContext('2d')!;

const backdrop = document.createElement('canvas') as HTMLCanvasElement & { __dirty?: boolean };
backdrop.width = VW;
backdrop.height = VH;
const bctx = backdrop.getContext('2d')!;
bctx.fillStyle = PERSONA_TOKENS.paperWhite;
bctx.fillRect(0, 0, VW, VH);
backdrop.__dirty = true;

const hud = document.createElement('canvas') as HTMLCanvasElement & { __dirty?: boolean };
hud.width = VW;
hud.height = VH;
const hctx = hud.getContext('2d')!;

/** Poster-ish window style built only from core facilities: quantise + ink edges + paper where mask<0.5. */
const poster: StylePass = {
  id: 'harness-poster',
  frag: `
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 c = texture(u_color, v_uv).rgb;
  float q = floor(luma(c) * 5.0 + 0.5) / 5.0;
  vec3 flatCol = mix(vec3(q), c, 0.6);
  float gx = luma(texture(u_color, v_uv + vec2(u_texel.x, 0.0)).rgb) - luma(texture(u_color, v_uv - vec2(u_texel.x, 0.0)).rgb);
  float gy = luma(texture(u_color, v_uv + vec2(0.0, u_texel.y)).rgb) - luma(texture(u_color, v_uv - vec2(0.0, u_texel.y)).rgb);
  float edge = smoothstep(0.08, 0.25, length(vec2(gx, gy)));
  float person = texture(u_mask, v_uv).r;
  vec3 paper = texture(u_backdrop, v_uv).rgb;
  vec3 col = mix(paper, flatCol, step(0.5, person));
  fragColor = vec4(mix(col, vec3(0.08), edge), 1.0);
}`,
};

function drawVideo(t: number): { cx: number; cy: number } {
  const g = vctx.createLinearGradient(0, 0, VW, VH);
  g.addColorStop(0, `hsl(${(t * 20) % 360} 60% 45%)`);
  g.addColorStop(1, `hsl(${(t * 20 + 120) % 360} 60% 35%)`);
  vctx.fillStyle = g;
  vctx.fillRect(0, 0, VW, VH);
  vctx.strokeStyle = 'rgba(255,255,255,0.25)';
  vctx.lineWidth = 2;
  for (let x = 0; x <= VW; x += 64) { vctx.beginPath(); vctx.moveTo(x, 0); vctx.lineTo(x, VH); vctx.stroke(); }
  for (let y = 0; y <= VH; y += 64) { vctx.beginPath(); vctx.moveTo(0, y); vctx.lineTo(VW, y); vctx.stroke(); }
  // "L" marker in the SOURCE top-left so mirroring is visible on screen.
  vctx.fillStyle = '#fff';
  vctx.fillRect(16, 16, 10, 60);
  vctx.fillRect(16, 66, 40, 10);
  const cx = VW * (0.5 + 0.2 * Math.sin(t * 0.7));
  const cy = VH * (0.45 + 0.08 * Math.cos(t * 0.9));
  vctx.fillStyle = '#2a1a12';
  vctx.beginPath();
  vctx.ellipse(cx, cy, 48, 62, 0, 0, Math.PI * 2);
  vctx.fill();
  return { cx, cy };
}

function drawOverlay(headSrc: { cx: number; cy: number }, mirrored: boolean): void {
  // Overlay is authored in DISPLAY space (already mirrored), like the persona layer does from mirrored landmarks.
  const x = mirrored ? VW - headSrc.cx : headSrc.cx;
  octx.clearRect(0, 0, VW, VH);
  octx.fillStyle = PERSONA_TOKENS.lensPink;
  octx.beginPath();
  octx.arc(x - 18, headSrc.cy - 10, 9, 0, Math.PI * 2);
  octx.arc(x + 18, headSrc.cy - 10, 9, 0, Math.PI * 2);
  octx.fill();
  overlay.__dirty = true;
}

function drawHud(fps: number, quad: WindowQuad, tint: string): void {
  hctx.clearRect(0, 0, VW, VH);
  hctx.fillStyle = tint;
  hctx.font = '300 12px Inter, system-ui, sans-serif';
  hctx.fillText(`${fps.toFixed(0)} fps`, 8, 16);
  const c = quad.corners[0];
  hctx.fillText('1610100', c.x * VW, c.y * VH - 6);
  hctx.fillRect(c.x * VW, c.y * VH, 6, 1);
  hctx.fillRect(c.x * VW, c.y * VH, 1, 6);
  hud.__dirty = true;
}

function animatedQuad(t: number, reduced: boolean): WindowQuad {
  const thick = reduced ? 0.3 : 0.02 + 0.28 * (0.5 + 0.5 * Math.sin(t * 0.6));
  const cx = 0.5 + 0.1 * Math.sin(t * 0.4);
  const cy = 0.5;
  const w = 0.3;
  const skew = 0.06 * Math.sin(t * 0.8);
  const corners: QuadCorners = [
    { x: cx - w, y: cy - thick / 2 + skew },
    { x: cx + w, y: cy - thick / 2 - skew },
    { x: cx + w, y: cy + thick / 2 - skew },
    { x: cx - w, y: cy + thick / 2 + skew },
  ];
  return { corners, opacity: 1, thickness: thick, area: 2 * w * thick, centroid: { x: cx, y: cy }, visible: true, ordering: 'convex' };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const info = document.getElementById('info')!;
  const mirrorBox = document.getElementById('mirror') as HTMLInputElement;
  const baseBox = document.getElementById('comic') as HTMLInputElement;
  const glitchBox = document.getElementById('glitch') as HTMLInputElement;
  const fitSelect = document.getElementById('fit') as HTMLSelectElement;
  const renderer = createRenderer();
  await renderer.init(canvas);
  const resize = (): void => {
    const r = canvas.getBoundingClientRect();
    renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const comicBase = presetOf([solid([0.9, 0.6, 0.2]), { id: 'tint', frag: 'void main(){ vec3 v = texture(u_video, v_uv).rgb; float l = dot(v, vec3(0.3,0.59,0.11)); fragColor = vec4(mix(texture(u_color, v_uv).rgb * l * 1.4, v, 0.3), 1.0); }' }], 'comic');
  const windowStyle = presetOf([poster], 'paper-portrait', true);
  // Warm both presets in idle time, exactly like the runtime does after init.
  renderer.warm([windowStyle, comicBase]);
  // Fake segmentation: disc region = person.
  const seg = { width: 128, height: 128, data: new Float32Array(128 * 128), texture: null };

  let frames = 0;
  let fps = 0;
  let last = performance.now();
  const loop = (now: number): void => {
    const t = now / 1000;
    const mirrored = mirrorBox.checked;
    const head = drawVideo(t);
    drawOverlay(head, mirrored);
    const quad = animatedQuad(t, false);
    // Mask authored in display space (mirrored like the tracker does).
    const hx = (mirrored ? VW - head.cx : head.cx) / VW;
    const hy = head.cy / VH;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const dx = (x / 128 - hx) * (VW / VH);
      const dy = y / 128 - hy;
      seg.data[y * 128 + x] = dx * dx / 0.03 + dy * dy / 0.05 < 1 ? 1 : 0;
    }
    frames++;
    if (now - last > 500) { fps = (frames * 1000) / (now - last); frames = 0; last = now; }
    drawHud(fps, quad, baseBox.checked ? '#ff2b2b' : '#f5f5f7');
    const fitMode: FitMode = fitSelect.value === 'contain' ? 'contain' : 'cover';
    const inputs: RenderInputs = {
      video, videoWidth: VW, videoHeight: VH, mirrored,
      tracking: { t: now, sourceWidth: VW, sourceHeight: VH, hands: [], face: null, segmentation: seg, timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 } },
      quad, scene: { ...DEFAULT_SCENE, base: baseBox.checked ? 'comic' : 'live' },
      baseStyle: baseBox.checked ? comicBase : null, windowStyle,
      personaOverlay: overlay, personaBackdrop: backdrop, hudOverlay: hud,
      glitch: glitchBox.checked ? Math.min(1, Math.max(0, 1 - quad.thickness / 0.04)) : 0,
      quality: { ...DEFAULT_QUALITY }, fitMode, time: t,
    };
    renderer.render(inputs);
    const d = renderer.getDebug();
    const gpu = renderer.stats.gpuMs === null ? (d?.gpuTimer ? 'pending' : 'n/a') : `${renderer.stats.gpuMs.toFixed(2)} ms`;
    const warm = renderer.warmPending > 0 ? ` · warming ${renderer.warmPending}` : '';
    info.textContent = `${canvas.width}×${canvas.height} · ${fitMode} · internal ${d?.internalWidth}×${d?.internalHeight} · ${renderer.stats.passes} passes · ${renderer.stats.lastFrameMs.toFixed(2)} ms CPU · GPU ${gpu} · ${d?.programs} programs${warm} · mask ${d?.maskFormat} · lost×${renderer.contextLossCount}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  document.getElementById('lose')?.addEventListener('click', () => {
    const ext = renderer.gl?.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    setTimeout(() => ext?.restoreContext(), 800);
  });
}

void main();
