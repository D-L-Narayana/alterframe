/**
 * Mounts the runtime on the stage canvas.
 *
 * Lifecycle per (spec, attempt): create the FrameSource → `startRuntime({ canvas, store, source })`
 * IMMEDIATELY (the model download overlaps the camera permission prompt) → start the source and
 * mirror its precise status (requesting / ready / denied / unavailable / error) into the session.
 * The RuntimeHandle lives in `handleRef` (production code never reads the dev-only window global).
 * On unmount, spec change or source switch a live recording is finalised and downloaded before the
 * runtime stops. The pure parts (`bootSession`, `teardownSession`, `preserveRecording`) are exported
 * for Node tests.
 */
import { useCallback, useEffect, type RefObject } from 'react';
import type { AppStore, FileTransport, FrameSource, RuntimeDeps, RuntimeHandle, SourceStatus } from '@/types';
import { useAppStore } from '@/state/store';
import { useUiStore } from '@/state/uiStore';
import { captureFilename, downloadBlob, mapSourceError } from './format';
import { createSourceFromSpec, type SourceSpec } from './sourceSpec';
import { startRuntime as startRealRuntime } from './runtimeBridge';

type FailureStatus = Extract<SourceStatus, 'denied' | 'unavailable' | 'error'>;
const isFailure = (s: SourceStatus): s is FailureStatus => s === 'denied' || s === 'unavailable' || s === 'error';
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface SessionBootDeps {
  canvas: HTMLCanvasElement;
  store: AppStore;
  spec: SourceSpec;
  /** Injection points for tests; default to the real media sources and runtime. */
  createSource?: (spec: SourceSpec) => FrameSource;
  startRuntime?: (deps: RuntimeDeps) => RuntimeHandle;
}

export interface SessionBoot {
  source: FrameSource;
  /** null when the runtime could not be created (the session then carries `sourceStatus: 'error'`). */
  handle: RuntimeHandle | null;
  /** Settles once the source start settled. Never rejects: failures are written to the session. */
  started: Promise<void>;
  /** Stops late session writes from this attempt (teardown, StrictMode remount, spec change). */
  cancel(): void;
}

export interface TeardownDeps {
  download?: (blob: Blob, filename: string) => void;
  notify?: (message: string, kind: 'status' | 'error') => void;
}

/**
 * Starts the source and mirrors the outcome into the session. Resolves `true` when the source became
 * ready, `false` when it failed (status + message already written). Writes nothing once cancelled.
 */
async function startSource(source: FrameSource, store: AppStore, isCancelled: () => boolean): Promise<boolean> {
  const { setSession } = store.getState();
  try {
    await source.start();
  } catch (err) {
    if (isCancelled()) return false;
    const mapped = mapSourceError(err);
    // Prefer the source's own status when it already classified the failure.
    const status = isFailure(source.status) ? source.status : mapped.status;
    setSession({ sourceStatus: status, sourceError: mapped.message });
    return false;
  }
  if (isCancelled()) return false;
  if (isFailure(source.status)) {
    const mapped = mapSourceError({ name: source.status === 'denied' ? 'NotAllowedError' : source.status === 'unavailable' ? 'NotFoundError' : 'Error' });
    setSession({ sourceStatus: source.status, sourceError: source.error ?? mapped.message });
    return false;
  }
  // `idle` here means stop() raced the start (teardown) — leave the session alone.
  if (source.status === 'ready') setSession({ sourceStatus: 'ready', sourceError: null });
  return source.status === 'ready';
}

/** The runtime's optional `ready` promise (renderer init) — a rejection means nothing will ever render. */
function watchRendererInit(handle: RuntimeHandle | null, store: AppStore, isCancelled: () => boolean): void {
  const ready = (handle as { ready?: unknown } | null)?.ready;
  if (!(ready instanceof Promise)) return;
  ready.catch((err: unknown) => {
    if (isCancelled()) return;
    store.getState().setSession({ sourceStatus: 'error', sourceError: `The renderer could not start: ${errorMessage(err)}` });
  });
}

/** Creates the source, starts the runtime at once, then starts the source (parallel model download). */
export function bootSession(deps: SessionBootDeps): SessionBoot {
  const { canvas, store, spec } = deps;
  const createSource = deps.createSource ?? createSourceFromSpec;
  const start = deps.startRuntime ?? startRealRuntime;
  let cancelled = false;
  const isCancelled = () => cancelled;

  const source = createSource(spec);
  store.getState().setSession({ sourceKind: source.kind, sourceStatus: 'requesting', sourceError: null });

  let handle: RuntimeHandle | null = null;
  try {
    handle = start({ canvas, store, source });
  } catch (err) {
    store.getState().setSession({ sourceStatus: 'error', sourceError: `The renderer could not start: ${errorMessage(err)}` });
  }
  watchRendererInit(handle, store, isCancelled);

  // The source is started only when a runtime exists to consume it (its own `ensureStarted` is idempotent).
  const started: Promise<void> = handle ? startSource(source, store, isCancelled).then(() => undefined) : Promise.resolve();
  return {
    source,
    handle,
    started,
    cancel() {
      cancelled = true;
    },
  };
}

/**
 * If a recording is in progress, stop it NOW (synchronously asks the recorder to finalise) and download
 * the result (size > 0) with the usual filename + toast. Resolves once the result is handled; never rejects.
 */
export function preserveRecording(handle: RuntimeHandle | null, deps: TeardownDeps = {}): Promise<void> {
  if (!handle || handle.recorder.state !== 'recording') return Promise.resolve();
  const download = deps.download ?? downloadBlob;
  const notify = deps.notify ?? (() => {});
  return handle.recorder
    .stop()
    .then(({ blob, mime }) => {
      if (blob.size > 0) {
        download(blob, captureFilename(mime));
        notify('Recording saved to your downloads', 'status');
      }
    })
    .catch((err: unknown) => {
      notify(`Could not save recording: ${errorMessage(err)}`, 'error');
    });
}

/** Preserve a live recording, stop the runtime and source, reset the per-runtime session fields. */
export function teardownSession(boot: Pick<SessionBoot, 'handle' | 'source' | 'cancel'>, store: AppStore, deps: TeardownDeps = {}): Promise<void> {
  boot.cancel();
  const pending = preserveRecording(boot.handle, deps);
  try {
    boot.handle?.stop();
  } catch {
    /* runtime already gone */
  }
  try {
    boot.source.stop();
  } catch {
    /* source already gone */
  }
  store.getState().setSession({
    trackerReady: false,
    trackerProgress: 0,
    trackerError: null,
    windowOpen: false,
    contextLost: false,
    fps: 0,
    recorderState: 'idle',
    recorderElapsedMs: 0,
    countdown: null,
    transport: null,
    captureRequest: null,
  });
  return pending;
}

export interface UseRuntimeResult {
  /** Swap the live source (camera switch / device change) without restarting the loop. */
  switchSource(spec: SourceSpec): Promise<void>;
  /** Playback controls of the current source (file sources only), or null. Read on demand, never during render. */
  getTransport(): FileTransport | null;
}

const uiNotify = (message: string, kind: 'status' | 'error') => useUiStore.getState().notify(message, kind);

export function useRuntime(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  handleRef: RefObject<RuntimeHandle | null>,
  sourceRef: RefObject<FrameSource | null>,
  spec: SourceSpec,
  attempt: number,
): UseRuntimeResult {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let boot: SessionBoot | null = null;
    // One microtask of deferral: React StrictMode (dev) mounts → unmounts → mounts effects synchronously,
    // so without it two runtimes (and two model downloads) would start. The camera prompt is not delayed.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      // A new runtime session: the tracker failure card may show again if this attempt fails too.
      useUiStore.getState().resetTrackerFailure();
      boot = bootSession({ canvas, store: useAppStore, spec });
      sourceRef.current = boot.source;
      handleRef.current = boot.handle;
    });
    return () => {
      cancelled = true;
      if (boot) void teardownSession(boot, useAppStore, { notify: uiNotify });
      handleRef.current = null;
      sourceRef.current = null;
      useUiStore.getState().setAutoStopMs(null);
    };
    // `attempt` is the retry counter from the ErrorPanel.
  }, [canvasRef, handleRef, sourceRef, spec, attempt]);

  const switchSource = useCallback(async (next: SourceSpec) => {
    const handle = handleRef.current;
    const previous = sourceRef.current;
    const source = createSourceFromSpec(next);
    try {
      // A recording in progress is saved before the frames change under it.
      await preserveRecording(handle, { notify: uiNotify });
      const ok = await startSource(source, useAppStore, () => false);
      if (!ok) throw new Error('source failed');
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
  }, [handleRef, sourceRef]);

  const getTransport = useCallback((): FileTransport | null => sourceRef.current?.transport ?? null, [sourceRef]);

  return { switchSource, getTransport };
}
