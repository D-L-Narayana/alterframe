/**
 * Drives the W4 renderer (`createRenderer`) with solid-colour passes built from the CONTRACT only
 * (StylePass = frag + uniforms), so this harness has no dependency on W4's built-in passes.
 * Exposes `window.__pixels.render(opts)` for render-pixels.spec.ts.
 */
import type { Renderer, RenderInputs, StylePass, StylePreset, QuadCorners, WindowQuad } from '@/types';
import { DEFAULT_QUALITY, DEFAULT_SCENE } from '@/types';

// Resolved at runtime by the Vite dev server (string variables keep tsc from resolving modules that other workers may not have written yet).
const CORE_PATH = '/src/render/core/index.ts';

interface RenderOpts {
  /** Normalized TL,TR,BR,BL corners; null hides the window. */
  corners: QuadCorners | null;
  opacity?: number;
  base: [number, number, number];
  window: [number, number, number];
  mirrored?: boolean;
  glitch?: number;
  videoWidth?: number;
  videoHeight?: number;
}

declare global {
  interface Window {
    __pixels?: {
      ready: boolean;
      error?: string;
      render(opts: RenderOpts): Promise<{ cssWidth: number; cssHeight: number; dpr: number; backing: { w: number; h: number } }>;
    };
  }
}

function solid(id: string, rgb: [number, number, number]): StylePass {
  return {
    id,
    frag: `uniform vec3 u_solid;\nvoid main(){ fragColor = vec4(u_solid, 1.0); }`,
    uniforms: () => ({ u_solid: rgb }),
  };
}

function preset(id: StylePreset['id'], pass: StylePass): StylePreset {
  return { id, passes: [pass], usesBackdrop: false };
}

function quadFrom(corners: QuadCorners, opacity: number): WindowQuad {
  const [a, b, c, d] = corners;
  const area = Math.abs((a.x * b.y - b.x * a.y) + (b.x * c.y - c.x * b.y) + (c.x * d.y - d.x * c.y) + (d.x * a.y - a.x * d.y)) / 2;
  return {
    corners,
    opacity,
    thickness: (Math.hypot(a.x - d.x, a.y - d.y) + Math.hypot(b.x - c.x, b.y - c.y)) / 2,
    area,
    centroid: { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 },
    visible: true,
    ordering: 'convex',
  };
}

async function main(): Promise<void> {
  const api: NonNullable<Window['__pixels']> = {
    ready: false,
    async render() {
      throw new Error('renderer not ready');
    },
  };
  window.__pixels = api;
  try {
    const mod = (await import(/* @vite-ignore */ CORE_PATH)) as Record<string, unknown>;
    const create = mod['createRenderer'];
    if (typeof create !== 'function') throw new Error('createRenderer not exported from src/render/core/index.ts');
    const renderer = (create as () => Renderer)();
    const canvas = document.getElementById('stage') as HTMLCanvasElement;
    await renderer.init(canvas);

    api.render = async (opts) => {
      const vw = opts.videoWidth ?? 640;
      const vh = opts.videoHeight ?? 360;
      // Synthetic "video": a 2D canvas in a third colour; solid passes ignore it anyway.
      const video = document.createElement('canvas');
      video.width = vw;
      video.height = vh;
      const ctx = video.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#204080';
        ctx.fillRect(0, 0, vw, vh);
      }
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, DEFAULT_QUALITY.maxDpr);
      renderer.resize(rect.width, rect.height, dpr);
      const inputs: RenderInputs = {
        video,
        videoWidth: vw,
        videoHeight: vh,
        mirrored: opts.mirrored ?? false,
        tracking: null,
        quad: opts.corners ? quadFrom(opts.corners, opts.opacity ?? 1) : null,
        scene: { ...DEFAULT_SCENE },
        baseStyle: preset('comic', solid('solid-base', opts.base)),
        windowStyle: preset('paper-portrait', solid('solid-window', opts.window)),
        personaOverlay: null,
        personaBackdrop: null,
        hudOverlay: null,
        glitch: opts.glitch ?? 0,
        quality: { ...DEFAULT_QUALITY },
        fitMode: 'cover',
        time: 0,
      };
      renderer.render(inputs);
      // Second frame: some compositors lazily allocate FBOs on first render.
      renderer.render({ ...inputs, time: 1 / 60 });
      return { cssWidth: rect.width, cssHeight: rect.height, dpr, backing: { w: canvas.width, h: canvas.height } };
    };
    api.ready = true;
  } catch (e) {
    api.error = e instanceof Error ? e.message : String(e);
    api.ready = true;
  }
}

void main();
