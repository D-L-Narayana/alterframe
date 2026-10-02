/**
 * Same-origin model loading with byte-level progress.
 *
 * MediaPipe can fetch `modelAssetPath` itself, but then we get no progress events for the
 * ~12 MB of models (the W1 loading bar needs them). So we stream each file ourselves and hand
 * MediaPipe a `modelAssetBuffer`. Buffers are cached per URL so a delegate switch (GPU→CPU) or
 * a re-configuration never downloads twice.
 */

export interface ModelSpec {
  /** Key used in progress accounting. */
  id: 'hands' | 'face' | 'segmentation';
  file: string;
  /** Fallback size (bytes) when the server sends no content-length (e.g. gzip without length). */
  expectedBytes: number;
}

export const MODEL_SPECS: readonly ModelSpec[] = [
  { id: 'hands', file: 'hand_landmarker.task', expectedBytes: 7_819_105 },
  { id: 'face', file: 'face_landmarker.task', expectedBytes: 3_758_596 },
  { id: 'segmentation', file: 'selfie_segmenter.tflite', expectedBytes: 249_537 },
];

/** Share of the progress bar reserved for the wasm runtime (its download is not observable). */
export const WASM_PROGRESS_SHARE = 0.08;
/** Share reserved for task construction (graph init, GPU shader compile) after the bytes arrive. */
export const INIT_PROGRESS_SHARE = 0.1;

export function joinUrl(base: string, file: string): string {
  return `${base.replace(/\/+$/, '')}/${file}`;
}

export class ModelCache {
  private readonly buffers = new Map<string, Promise<Uint8Array>>();

  /**
   * Fetch (once) and return the model bytes. `onBytes(loaded, total)` is called per chunk.
   * Errors mention the URL and HTTP status so a missing `public/models` file is obvious.
   */
  load(url: string, expectedBytes: number, onBytes?: (loaded: number, total: number) => void): Promise<Uint8Array> {
    let p = this.buffers.get(url);
    if (!p) {
      p = fetchWithProgress(url, expectedBytes, onBytes);
      this.buffers.set(url, p);
      p.catch(() => this.buffers.delete(url)); // allow retry after a failure
    } else if (onBytes) {
      // Already cached: report completion immediately so progress accounting stays consistent.
      void p.then((b) => onBytes(b.byteLength, b.byteLength));
    }
    return p;
  }

  clear(): void {
    this.buffers.clear();
  }
}

async function fetchWithProgress(url: string, expectedBytes: number, onBytes?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`[tracking] model download failed: ${url} → HTTP ${res.status}`);
  const headerLen = Number(res.headers.get('content-length'));
  const total = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : expectedBytes;

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onBytes?.(Math.min(loaded, total), total);
    }
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  onBytes?.(loaded, loaded);
  return out;
}

/**
 * Aggregates per-model byte progress into one 0..1 number:
 * [0, WASM) wasm → [WASM, 1-INIT) bytes → [1-INIT, 1] task construction.
 * Monotonic by construction (never reports a lower value than before).
 */
export class ProgressAggregator {
  private readonly loaded = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  private wasmDone = false;
  private initDone = 0;
  private initTotal = 1;
  private last = -1;

  constructor(private readonly report: ((p: number) => void) | undefined, specs: readonly ModelSpec[], initSteps: number) {
    for (const s of specs) { this.totals.set(s.id, s.expectedBytes); this.loaded.set(s.id, 0); }
    this.initTotal = Math.max(1, initSteps);
    this.emit();
  }

  wasmReady(): void { this.wasmDone = true; this.emit(); }

  bytes(id: string, loaded: number, total: number): void {
    this.loaded.set(id, loaded);
    if (total > 0) this.totals.set(id, total);
    this.emit();
  }

  initStep(): void { this.initDone = Math.min(this.initTotal, this.initDone + 1); this.emit(); }

  done(): void { this.wasmDone = true; this.initDone = this.initTotal; for (const [k, t] of this.totals) this.loaded.set(k, t); this.emit(); }

  private emit(): void {
    let l = 0, t = 0;
    for (const [k, total] of this.totals) { t += total; l += Math.min(total, this.loaded.get(k) ?? 0); }
    const bytesShare = 1 - WASM_PROGRESS_SHARE - INIT_PROGRESS_SHARE;
    const p = (this.wasmDone ? WASM_PROGRESS_SHARE : 0)
      + bytesShare * (t > 0 ? l / t : 1)
      + INIT_PROGRESS_SHARE * (this.initDone / this.initTotal);
    const clamped = Math.min(1, Math.max(0, p));
    if (clamped <= this.last && this.last !== -1) return;
    this.last = clamped;
    this.report?.(clamped);
  }
}
