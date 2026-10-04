import type { CaptureAspect, SnapshotFormat, SnapshotOptions } from '@/types/capture';
import { computeCrop } from './crop';
import type { CanvasLike } from './recorder';

export interface SnapshotDeps {
  /** Factory for the intermediate crop canvas. Default: `document.createElement('canvas')`. */
  createCanvas?: (width: number, height: number) => CanvasLike;
}

/** `snapshot()` takes the contract options (format, quality) and the injection points in one object. */
export type SnapshotCallOptions = SnapshotOptions & SnapshotDeps;

/** Encoder quality used for JPEG/WebP when `SnapshotOptions.quality` is omitted. */
export const DEFAULT_SNAPSHOT_QUALITY = 0.92;

const PNG = 'image/png';
const SNAPSHOT_MIME: Record<SnapshotFormat, string> = { png: PNG, jpeg: 'image/jpeg', webp: 'image/webp' };
const SNAPSHOT_LABEL: Record<SnapshotFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' };

/** Mime type requested from the canvas encoder for a snapshot format. */
export function snapshotMime(format: SnapshotFormat = 'png'): string {
  return SNAPSHOT_MIME[format];
}

interface EncodableCanvas extends CanvasLike {
  toBlob?(cb: (blob: Blob | null) => void, type?: string, quality?: number): void;
  convertToBlob?(opts?: { type?: string; quality?: number }): Promise<Blob>;
}

function defaultCreateCanvas(w: number, h: number): CanvasLike {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c as unknown as CanvasLike;
}

/** Lossy quality 0..1; NaN/undefined → the default. */
function clampQuality(q: number | undefined): number {
  if (q === undefined || Number.isNaN(q)) return DEFAULT_SNAPSHOT_QUALITY;
  return Math.min(1, Math.max(0, q));
}

interface EncodeAttempt {
  /** Non-empty Blob, or null when the encoder produced nothing. */
  blob: Blob | null;
  /** Message of a thrown/rejected encoder error, if any. */
  error?: string;
}

/**
 * One encoder call: `canvas.toBlob(cb, type, quality)` or `OffscreenCanvas.convertToBlob({ type, quality })`.
 * Throws synchronously when the canvas has neither (a capability problem, not an encoding failure).
 */
function encodeOnce(target: EncodableCanvas, type: string, quality: number | undefined): Promise<EncodeAttempt> {
  const asAttempt = (blob: Blob | null): EncodeAttempt => ({ blob: blob && blob.size > 0 ? blob : null });
  const asError = (e: unknown): EncodeAttempt => ({ blob: null, error: e instanceof Error ? e.message : String(e) });
  const toBlob = target.toBlob;
  if (typeof toBlob === 'function') {
    return new Promise<EncodeAttempt>((resolve) => {
      try {
        const cb = (blob: Blob | null) => resolve(asAttempt(blob));
        if (quality === undefined) toBlob.call(target, cb, type);
        else toBlob.call(target, cb, type, quality);
      } catch (e) {
        resolve(asError(e));
      }
    });
  }
  const convertToBlob = target.convertToBlob;
  if (typeof convertToBlob === 'function') {
    const opts = quality === undefined ? { type } : { type, quality };
    return convertToBlob.call(target, opts).then(asAttempt, asError);
  }
  throw new Error('Snapshot canvas has no toBlob/convertToBlob encoder.');
}

/**
 * Image of the current composited frame, centre-cropped with the same math as the recorder.
 * Always goes through an intermediate canvas so the output has even dimensions and the stage's
 * WebGL drawing buffer is read exactly once (requires `preserveDrawingBuffer: true` on the stage
 * canvas, which the compositor sets).
 *
 * Format: `png` (default, lossless, no quality) or `jpeg`/`webp` with `quality` (default 0.92).
 * Browsers that cannot encode the requested type return a PNG instead (Chromium, Safari) or
 * nothing; both cases fall back to PNG transparently. The returned Blob's `type` is therefore the
 * real format — name the file with `extensionForMime(blob.type)`.
 */
export async function snapshot(canvas: HTMLCanvasElement, aspect: CaptureAspect, deps: SnapshotCallOptions = {}): Promise<Blob> {
  const format: SnapshotFormat = deps.format ?? 'png';
  const type = SNAPSHOT_MIME[format];
  const quality = format === 'png' ? undefined : clampQuality(deps.quality);
  let target: EncodableCanvas | null = null;
  try {
    const source = canvas as unknown as CanvasLike;
    const plan = computeCrop(source.width, source.height, aspect); // throws readable error on empty
    target = (deps.createCanvas ?? defaultCreateCanvas)(plan.dw, plan.dh) as EncodableCanvas;
    const ctx = target.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not create a 2D context for the snapshot canvas.');
    ctx.drawImage(source, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.dw, plan.dh);

    const first = await encodeOnce(target, type, quality);
    // The requested type, or the browser's own silent PNG fallback: both are final.
    if (first.blob && (type === PNG || first.blob.type === type || first.blob.type === PNG)) return first.blob;
    let detail = first.error;
    if (type !== PNG) {
      // Unsupported lossy encoder (nothing, an error, or an unexpected type): re-encode as PNG.
      const png = await encodeOnce(target, PNG, undefined);
      if (png.blob) return png.blob;
      detail = png.error ?? detail;
    }
    throw new Error(`Could not encode the snapshot as ${SNAPSHOT_LABEL[format]}${detail ? `: ${detail}` : '.'}`);
  } finally {
    if (target) {
      // Zero-size canvas releases its backing store immediately.
      target.width = 0;
      target.height = 0;
    }
  }
}

export interface DownloadDeps {
  document?: {
    createElement(tag: 'a'): { href: string; download: string; rel: string; style: { display: string }; click(): void; remove(): void };
    body: { appendChild(node: unknown): unknown };
  };
  URL?: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  /** Delay before revoking the object URL so the browser has started the download. Default 1000. */
  revokeDelayMs?: number;
}

/** Trigger a browser download of `blob` as `filename` (use `captureFilename()` for the name). */
export function download(blob: Blob, filename: string, deps: DownloadDeps = {}): void {
  const doc = deps.document ?? (document as unknown as NonNullable<DownloadDeps['document']>);
  const urlApi = deps.URL ?? URL;
  const href = urlApi.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => urlApi.revokeObjectURL(href), deps.revokeDelayMs ?? 1000);
}
