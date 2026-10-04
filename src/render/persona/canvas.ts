/**
 * Canvas abstraction for the persona layer.
 *  - In the browser we prefer OffscreenCanvas (no DOM, cheap), falling back to HTMLCanvasElement.
 *  - In Node tests a fake factory is injected so `update()` logic stays testable without pixels.
 *
 * `__dirty` protocol (`DirtyCanvas` in src/types/runtime.ts): the producer sets `__dirty = true`
 * whenever it repaints; the renderer (W4) uploads the texture and sets it back to `false`.
 */

/** Minimal 2D API we rely on — identical on CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D. */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface PersonaCanvasLike {
  width: number;
  height: number;
  __dirty?: boolean;
  getContext(contextId: '2d', options?: CanvasRenderingContext2DSettings): Ctx2D | null;
}

export type PersonaCanvasFactory = (width: number, height: number) => PersonaCanvasLike;

/** Browser default: OffscreenCanvas when available, otherwise a detached <canvas>. */
export const defaultCanvasFactory: PersonaCanvasFactory = (width, height) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height) as unknown as PersonaCanvasLike;
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  return c as unknown as PersonaCanvasLike;
};

export function getCtx(canvas: PersonaCanvasLike): Ctx2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('persona layer: 2D context unavailable');
  return ctx;
}

declare global {
  // Module augmentation so `layer.overlay.__dirty` type-checks for consumers that hold the
  // contract type `HTMLCanvasElement | OffscreenCanvas` (see src/types/runtime.ts DirtyCanvas).
  interface HTMLCanvasElement { __dirty?: boolean }
  interface OffscreenCanvas { __dirty?: boolean }
}
