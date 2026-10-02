import type { RuntimeHandle } from '@/types';

/**
 * Compile-time gate for every debug affordance (window.__alterframe,
 * injectTracking, stub warnings).
 *
 *  • `import.meta.env.DEV`  — `vite` dev server / vitest.
 *  • `import.meta.env.VITE_E2E === '1'` — an explicit e2e BUILD
 *    (`VITE_E2E=1 vite build|dev`), used by W10's Playwright runs.
 *
 * Both are static strings substituted by Vite at build time, so in the plain
 * production bundle this constant is literally `false`, the branches below are
 * dead code and are dropped. A `?mockTracking=1` query string on a production
 * URL therefore CANNOT enable injection: nothing reads the query string here.
 */
export const DEV_BRIDGE_ENABLED: boolean = import.meta.env.DEV === true || import.meta.env.VITE_E2E === '1';

/** Installs `window.__alterframe` when the gate is open. Returns a remover (no-op otherwise). */
export function installDevBridge(handle: RuntimeHandle): () => void {
  if (!DEV_BRIDGE_ENABLED) return () => {};
  const w = globalThis as typeof globalThis & { window?: Window };
  if (!w.window) return () => {};
  w.window.__alterframe = handle;
  return () => {
    if (w.window && w.window.__alterframe === handle) delete w.window.__alterframe;
  };
}

/** Dev-only console warning (silent in production builds). */
export function devWarn(message: string): void {
  if (DEV_BRIDGE_ENABLED && import.meta.env.MODE !== 'test') console.warn(`[alterframe/runtime] ${message}`);
}
