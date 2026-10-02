/**
 * Mounts the W2 runtime on the stage canvas (W1).
 *
 * Lifecycle per (spec, attempt): create FrameSource → start it (mirrors its status into the
 * session slice) → `startRuntime({ canvas, store, source })` → expose the RuntimeHandle through
 * `handleRef` (production code paths use this ref, never the dev-only `window.__alterframe`).
 * Everything is torn down on unmount or when the spec changes. Any throw lands in the
 * session as `sourceStatus: 'error'` so the ErrorPanel can offer retry / file fallback.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { FrameSource, RuntimeHandle } from '@/types';
import { useAppStore } from '@/state/store';
import { mapSourceError } from './format';
import { createSourceFromSpec, type SourceSpec } from './sourceSpec';
import { startRuntime } from './runtimeBridge';

export interface UseRuntimeResult {
  /** Swap the live source (camera switch / device change) without restarting the loop. */
  switchSource(spec: SourceSpec): Promise<void>;
}

async function startSource(source: FrameSource): Promise<void> {
  const { setSession } = useAppStore.getState();
  setSession({ sourceKind: source.kind, sourceStatus: 'requesting', sourceError: null });
  try {
    await source.start();
  } catch (err) {
    const mapped = mapSourceError(err);
    // Prefer the source's own status when it already classified the failure.
    const status = source.status === 'denied' || source.status === 'unavailable' || source.status === 'error' ? source.status : mapped.status;
    setSession({ sourceStatus: status, sourceError: mapped.message });
    throw err;
  }
  if (source.status === 'denied' || source.status === 'unavailable' || source.status === 'error') {
    const mapped = mapSourceError({ name: source.status === 'denied' ? 'NotAllowedError' : source.status === 'unavailable' ? 'NotFoundError' : 'Error' });
    setSession({ sourceStatus: source.status, sourceError: mapped.message });
    throw new Error(mapped.message);
  }
  setSession({ sourceStatus: 'ready', sourceError: null });
}

export function useRuntime(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  handleRef: RefObject<RuntimeHandle | null>,
  spec: SourceSpec,
  attempt: number,
): UseRuntimeResult {
  const sourceRef = useRef<FrameSource | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let source: FrameSource | null = null;
    let handle: RuntimeHandle | null = null;

    (async () => {
      try {
        source = createSourceFromSpec(spec);
        sourceRef.current = source;
        await startSource(source);
        if (cancelled) return;
        handle = startRuntime({ canvas, store: useAppStore, source });
        handleRef.current = handle;
      } catch (err) {
        if (cancelled) return;
        const s = useAppStore.getState();
        // startSource already classified source failures; anything else is a runtime failure.
        if (s.sourceStatus === 'ready' || s.sourceStatus === 'requesting') {
          s.setSession({ sourceStatus: 'error', sourceError: mapSourceError(err).message });
        }
      }
    })();

    return () => {
      cancelled = true;
      try { handle?.stop(); } catch { /* runtime already gone */ }
      try { source?.stop(); } catch { /* source already gone */ }
      handleRef.current = null;
      sourceRef.current = null;
      const s = useAppStore.getState();
      s.setSession({ trackerReady: false, fps: 0, recorderState: 'idle', recorderElapsedMs: 0 });
    };
    // `attempt` is the retry counter from the ErrorPanel.
  }, [canvasRef, handleRef, spec, attempt]);

  const switchSource = useCallback(async (next: SourceSpec) => {
    const handle = handleRef.current;
    const previous = sourceRef.current;
    const source = createSourceFromSpec(next);
    try {
      await startSource(source);
      if (handle) await handle.setSource(source);
      sourceRef.current = source;
      previous?.stop();
    } catch {
      // startSource already wrote the error to the session; keep the previous source alive.
      source.stop();
      if (previous && previous.status === 'ready') {
        useAppStore.getState().setSession({ sourceStatus: 'ready', sourceError: null });
      }
    }
  }, [handleRef]);

  return { switchSource };
}
