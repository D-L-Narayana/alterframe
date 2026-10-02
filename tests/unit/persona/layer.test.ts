import { describe, it, expect } from 'vitest';
import { createPersonaLayer } from '../../../src/render/persona';
import type { PersonaCanvasLike, PersonaCanvasFactory } from '../../../src/render/persona/canvas';
import { makeFace, makeFrame } from './fixtures';
import type { SceneState } from '../../../src/types';

/** Records every 2D-context method call so tests can count redraws without a real canvas. */
function fakeCanvasFactory(): { factory: PersonaCanvasFactory; calls: Map<PersonaCanvasLike, number> } {
  const calls = new Map<PersonaCanvasLike, number>();
  const factory: PersonaCanvasFactory = (w, h) => {
    const canvas: PersonaCanvasLike = {
      width: w, height: h,
      getContext: () => ctx,
    };
    // Proxy that swallows property sets and counts method calls as "draw work".
    const ctx = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'canvas') return canvas;
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
        if (prop === 'createPattern') return () => ({});
        return () => { calls.set(canvas, (calls.get(canvas) ?? 0) + 1); return undefined; };
      },
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    calls.set(canvas, 0);
    return canvas;
  };
  return { factory, calls };
}

const scene = (persona: SceneState['persona']): SceneState => ({ base: 'live', persona, hudTint: 'white' });
const size = { width: 640, height: 360 };

describe('createPersonaLayer', () => {
  it('exposes overlay/backdrop canvases sized by resize() and reports the current persona', () => {
    const { factory } = fakeCanvasFactory();
    const layer = createPersonaLayer({ createCanvas: factory, reducedMotion: false });
    layer.resize(size);
    expect(layer.overlay.width).toBe(640);
    expect(layer.overlay.height).toBe(360);
    expect(layer.backdrop.width).toBe(640);
    expect(layer.backdrop.height).toBe(360);
    layer.update(makeFrame(makeFace()), scene('masked'), 0);
    expect(layer.personaId).toBe('masked');
  });

  it('marks both canvases dirty after the first update and does no work when inputs are unchanged', () => {
    const { factory, calls } = fakeCanvasFactory();
    const layer = createPersonaLayer({ createCanvas: factory, reducedMotion: false });
    layer.resize(size);
    const frame = makeFrame(makeFace());
    layer.update(frame, scene('portrait'), 0);
    expect(layer.overlay.__dirty).toBe(true);
    expect(layer.backdrop.__dirty).toBe(true);
    const o1 = calls.get(layer.overlay)!, b1 = calls.get(layer.backdrop)!;
    expect(o1).toBeGreaterThan(0);
    expect(b1).toBeGreaterThan(0);
    // consumer (renderer) acknowledges the upload
    layer.overlay.__dirty = false; layer.backdrop.__dirty = false;
    layer.update(makeFrame(makeFace()), scene('portrait'), 16);
    expect(calls.get(layer.overlay)).toBe(o1);
    expect(calls.get(layer.backdrop)).toBe(b1);
    expect(layer.overlay.__dirty).toBe(false);
    expect(layer.backdrop.__dirty).toBe(false);
  });

  it('redraws only the overlay when the face moves on a static backdrop persona', () => {
    const { factory, calls } = fakeCanvasFactory();
    const layer = createPersonaLayer({ createCanvas: factory, reducedMotion: false });
    layer.resize(size);
    layer.update(makeFrame(makeFace()), scene('suit'), 0);
    const o1 = calls.get(layer.overlay)!, b1 = calls.get(layer.backdrop)!;
    layer.overlay.__dirty = false; layer.backdrop.__dirty = false;
    layer.update(makeFrame(makeFace({ cx: 0.55 })), scene('suit'), 16);
    expect(calls.get(layer.overlay)).toBeGreaterThan(o1);
    expect(calls.get(layer.backdrop)).toBe(b1);
    expect(layer.overlay.__dirty).toBe(true);
    expect(layer.backdrop.__dirty).toBe(false);
  });

  it('animates the masked backdrop over time, but not under reduced motion', () => {
    for (const reducedMotion of [false, true]) {
      const { factory, calls } = fakeCanvasFactory();
      const layer = createPersonaLayer({ createCanvas: factory, reducedMotion });
      layer.resize(size);
      layer.update(makeFrame(makeFace()), scene('masked'), 0);
      const b1 = calls.get(layer.backdrop)!;
      layer.backdrop.__dirty = false;
      layer.update(makeFrame(makeFace()), scene('masked'), 500);
      if (reducedMotion) {
        expect(calls.get(layer.backdrop)).toBe(b1);
        expect(layer.backdrop.__dirty).toBe(false);
      } else {
        expect(calls.get(layer.backdrop)).toBeGreaterThan(b1);
        expect(layer.backdrop.__dirty).toBe(true);
      }
    }
  });

  it('resize forces a redraw of both canvases on the next update and resizes them', () => {
    const { factory, calls } = fakeCanvasFactory();
    const layer = createPersonaLayer({ createCanvas: factory, reducedMotion: false });
    layer.resize(size);
    layer.update(makeFrame(makeFace()), scene('portrait'), 0);
    const o1 = calls.get(layer.overlay)!, b1 = calls.get(layer.backdrop)!;
    layer.overlay.__dirty = false; layer.backdrop.__dirty = false;
    layer.resize({ width: 1280, height: 720 });
    expect(layer.overlay.width).toBe(1280);
    layer.update(makeFrame(makeFace()), scene('portrait'), 16);
    expect(calls.get(layer.overlay)).toBeGreaterThan(o1);
    expect(calls.get(layer.backdrop)).toBeGreaterThan(b1);
  });

  it('clears the overlay (still a draw) when the face is lost and then idles', () => {
    const { factory, calls } = fakeCanvasFactory();
    const layer = createPersonaLayer({ createCanvas: factory, reducedMotion: false });
    layer.resize(size);
    layer.update(makeFrame(makeFace()), scene('portrait'), 0);
    layer.overlay.__dirty = false;
    layer.update(makeFrame(null), scene('portrait'), 16);
    expect(layer.overlay.__dirty).toBe(true);
    const o2 = calls.get(layer.overlay)!;
    layer.overlay.__dirty = false;
    layer.update(makeFrame(null), scene('portrait'), 32);
    layer.update(null, scene('portrait'), 48);
    expect(calls.get(layer.overlay)).toBe(o2);
    expect(layer.overlay.__dirty).toBe(false);
  });

  it('setReducedMotion toggles the backdrop animation at runtime', () => {
    const { factory, calls } = fakeCanvasFactory();
    const layer = createPersonaLayer({ createCanvas: factory, reducedMotion: true });
    layer.resize(size);
    layer.update(makeFrame(makeFace()), scene('masked'), 0);
    const b1 = calls.get(layer.backdrop)!;
    layer.update(makeFrame(makeFace()), scene('masked'), 500);
    expect(calls.get(layer.backdrop)).toBe(b1);
    layer.setReducedMotion(false);
    layer.update(makeFrame(makeFace()), scene('masked'), 1000);
    expect(calls.get(layer.backdrop)).toBeGreaterThan(b1);
  });
});
