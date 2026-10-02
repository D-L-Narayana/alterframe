import type { CaptureAspect } from '@/types/capture';
import { computeCrop } from './crop';
import type { CanvasLike } from './recorder';

export interface SnapshotDeps {
  /** Factory for the intermediate crop canvas. Default: `document.createElement('canvas')`. */
  createCanvas?: (width: number, height: number) => CanvasLike;
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

/**
 * PNG of the current composited frame, centre-cropped with the same math as the recorder.
 * Always goes through an intermediate canvas so the output has even dimensions and the stage's
 * WebGL drawing buffer is read exactly once (requires `preserveDrawingBuffer: true` on the stage,
 * which W4 sets).
 */
export function snapshot(canvas: HTMLCanvasElement, aspect: CaptureAspect, deps: SnapshotDeps = {}): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    let target: EncodableCanvas | null = null;
    const release = () => {
      if (target) {
        target.width = 0;
        target.height = 0;
        target = null;
      }
    };
    try {
      const source = canvas as unknown as CanvasLike;
      const plan = computeCrop(source.width, source.height, aspect); // throws readable error on empty
      target = (deps.createCanvas ?? defaultCreateCanvas)(plan.dw, plan.dh) as EncodableCanvas;
      const ctx = target.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Could not create a 2D context for the snapshot canvas.');
      ctx.drawImage(source, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.dw, plan.dh);

      const done = (blob: Blob | null) => {
        release();
        if (blob && blob.size > 0) resolve(blob);
        else reject(new Error('Could not encode the snapshot as PNG.'));
      };
      if (typeof target.toBlob === 'function') {
        target.toBlob(done, 'image/png');
      } else if (typeof target.convertToBlob === 'function') {
        target.convertToBlob({ type: 'image/png' }).then(done, (e: unknown) => {
          release();
          reject(new Error(`Could not encode the snapshot as PNG: ${e instanceof Error ? e.message : String(e)}`));
        });
      } else {
        throw new Error('Snapshot canvas has no toBlob/convertToBlob encoder.');
      }
    } catch (e) {
      release();
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
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
