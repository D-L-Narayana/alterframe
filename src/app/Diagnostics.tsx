/**
 * Diagnostics group of the Settings sheet: a `<dl>` refreshed at 2 Hz from `handle.getDiagnostics?.()`
 * while the sheet is open, plus "Copy diagnostics" (clipboard → JSON) with a visible `<pre>` fallback.
 */
import { useEffect, useState } from 'react';
import type { RuntimeDiagnostics, Size } from '@/types';
import { useUiStore } from '@/state/uiStore';
import { Button } from '@/ui';

export const DIAGNOSTIC_ROWS = ['Tracking', 'Frame', 'Tracking time', 'Render time', 'GPU time', 'Quality', 'Renderer', 'Source'] as const;
export type DiagnosticTerm = (typeof DIAGNOSTIC_ROWS)[number];

export interface DiagnosticRow { term: DiagnosticTerm; detail: string }

const ms = (v: number, digits = 1) => `${v.toFixed(digits)} ms`;
const size = (s: Size | null) => (s ? `${s.width}×${s.height}` : 'n/a');

export function formatDiagnostics(d: RuntimeDiagnostics | null): DiagnosticRow[] {
  if (!d) return DIAGNOSTIC_ROWS.map((term) => ({ term, detail: term === 'Tracking' ? 'Not running' : 'n/a' }));
  const del = d.tracker.delegates;
  const delegates = del
    ? (['hands', 'face', 'segmentation'] as const).map((k) => (del[k] ? `${del[k]} ${k}` : `${k} off`)).join(' · ')
    : null;
  const tracking = d.tracker.error
    ? `Failed: ${d.tracker.error}`
    : d.tracker.ready
      ? `Ready${delegates ? ` · ${delegates}` : ''}`
      : `Loading ${Math.round(Math.min(1, Math.max(0, d.tracker.progress)) * 100)}%`;
  const warnings = d.tracker.warnings.length > 0 ? ` · ${d.tracker.warnings.length} warning${d.tracker.warnings.length === 1 ? '' : 's'}` : '';
  const inference = d.tracker.inferenceSize ? ` (${size(d.tracker.inferenceSize)})` : '';
  return [
    { term: 'Tracking', detail: tracking + warnings },
    { term: 'Frame', detail: `${Math.round(d.fps)} fps · ${ms(d.frameMs)} · ${d.frames} frames` },
    { term: 'Tracking time', detail: ms(d.trackingMs) },
    { term: 'Render time', detail: ms(d.renderMs) },
    { term: 'GPU time', detail: d.gpuMs === null ? 'n/a' : ms(d.gpuMs, 2) },
    {
      term: 'Quality',
      detail: `render ${Math.round(d.quality.renderScale * 100)}% · segmentation every ${d.quality.segmentationStride} · face every ${d.quality.faceStride} · tracking ≤ ${d.quality.inferenceMaxHeight}p${inference}`,
    },
    {
      term: 'Renderer',
      detail: d.renderer
        ? `${size(d.renderer.internal)} internal · mask ${d.renderer.maskFormat ?? 'n/a'} · context ${d.renderer.contextLost ? 'LOST' : 'ok'} · lost ${d.renderer.contextLossCount}×`
        : 'n/a',
    },
    { term: 'Source', detail: `${d.source.kind} · ${d.source.status} · ${d.source.width}×${d.source.height}` },
  ];
}

type ClipboardLike = { writeText(text: string): Promise<void> } | undefined;

function defaultClipboard(): ClipboardLike {
  const nav = (globalThis as { navigator?: { clipboard?: ClipboardLike } }).navigator;
  return nav?.clipboard;
}

/** Resolves true on success; false when the Clipboard API is missing or rejects (never throws). */
export async function copyToClipboard(text: string, clipboard: ClipboardLike = defaultClipboard()): Promise<boolean> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface DiagnosticsProps {
  /** Reads the live snapshot (`handle.getDiagnostics?.()`); null/undefined when no runtime is running. */
  getDiagnostics?: () => RuntimeDiagnostics | null;
}

const REFRESH_MS = 500;

export function Diagnostics({ getDiagnostics }: DiagnosticsProps) {
  const [diag, setDiag] = useState<RuntimeDiagnostics | null>(() => getDiagnostics?.() ?? null);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    if (!getDiagnostics) return;
    const id = window.setInterval(() => setDiag(getDiagnostics() ?? null), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [getDiagnostics]);

  const text = JSON.stringify(diag ?? { runtime: 'not running' }, null, 2);
  const copy = async () => {
    const ok = await copyToClipboard(text);
    setCopyFailed(!ok);
    useUiStore.getState().notify(ok ? 'Diagnostics copied' : 'Copy failed — select the text below', ok ? 'status' : 'error');
  };

  return (
    <>
      <dl className="af-diag">
        {formatDiagnostics(diag).map((r) => (
          <div key={r.term} className="af-diag__row">
            <dt>{r.term}</dt>
            <dd>{r.detail}</dd>
          </div>
        ))}
      </dl>
      <Button onClick={() => void copy()}>Copy diagnostics</Button>
      {copyFailed ? <pre className="af-diag__pre" tabIndex={0} aria-label="Diagnostics JSON">{text}</pre> : null}
    </>
  );
}
