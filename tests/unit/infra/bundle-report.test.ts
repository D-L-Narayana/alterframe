/**
 * Bundle report helpers (owner: W10): entry-chunk detection from dist/index.html, MediaPipe
 * detection in a chunk (code markers + sourcemap sources) and the budget policy — total JS gzip is
 * a hard limit; the entry-chunk budget and the "no MediaPipe in the entry chunk" rule are warnings
 * until `--strict` (CI flips the flag once the tracking module is a lazy chunk).
 */
import { describe, it, expect } from 'vitest';
import { entryChunksOf, mediaPipeMarkers, evaluateBudgets, parseFlags, fmtKb, DEFAULT_BUDGET_JS_GZ, DEFAULT_BUDGET_ENTRY_GZ } from '../../../scripts/bundle-report.mjs';

describe('default budgets (decimal kB, as in Vite build output)', () => {
  it('total JS 450 kB gz (unchanged since 0.1); entry chunk 128 kB gz = 125.1 kB measured on the v0.2 build + ≈ 2 % headroom', () => {
    expect(DEFAULT_BUDGET_JS_GZ).toBe(450_000);
    expect(DEFAULT_BUDGET_ENTRY_GZ).toBe(128_000);
    // The measured entry chunk must fit; a budget far above it would stop catching growth.
    const measuredEntryGz = 125_130;
    expect(measuredEntryGz).toBeLessThan(DEFAULT_BUDGET_ENTRY_GZ);
    expect(DEFAULT_BUDGET_ENTRY_GZ - measuredEntryGz).toBeLessThan(4_000);
  });
});

const HTML = `<!doctype html><html><head>
<script type="module" crossorigin src="./assets/index-Bryu977R.js"></script>
<link rel="modulepreload" crossorigin href="./assets/vendor-abc123.js">
<link rel="stylesheet" crossorigin href="./assets/index-mjwrTW_8.css">
</head><body><div id="root"></div></body></html>`;

describe('entryChunksOf', () => {
  it('returns the JS files the document loads up-front (module scripts + modulepreload), not CSS', () => {
    expect(entryChunksOf(HTML)).toEqual(['index-Bryu977R.js', 'vendor-abc123.js']);
  });
  it('handles absolute asset paths and ignores inline/other scripts', () => {
    expect(entryChunksOf('<script type="module" src="/assets/app-1.js"></script><script src="https://example.invalid/x.js"></script>')).toEqual(['app-1.js']);
    expect(entryChunksOf('<div></div>')).toEqual([]);
  });
});

describe('mediaPipeMarkers', () => {
  it('finds MediaPipe by code markers', () => {
    expect(mediaPipeMarkers('var x="mediapipe.tasks.vision.hand_landmarker.HandLandmarkerGraphOptions";', [])).toEqual(expect.arrayContaining(['code: mediapipe.tasks.vision']));
    expect(mediaPipeMarkers('import("@mediapipe/tasks-vision")', [])).toEqual(expect.arrayContaining(['code: @mediapipe', 'code: tasks-vision']));
  });
  it('finds MediaPipe through sourcemap sources', () => {
    expect(mediaPipeMarkers('console.log(1)', ['../../src/main.tsx', '../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs'])).toEqual(['sourcemap: node_modules/@mediapipe/tasks-vision']);
  });
  it('is empty for an app-only chunk', () => {
    expect(mediaPipeMarkers('const a = 1; const vision = "ok";', ['../../src/app/App.tsx'])).toEqual([]);
  });
});

describe('evaluateBudgets', () => {
  const base = { totalJsGz: 100_000, entryGz: 90_000, budgets: { totalJsGz: 450_000, entryGz: 128_000 }, mediaPipeHits: [] as string[] };

  it('passes when everything is within budget and the entry chunk is MediaPipe-free', () => {
    expect(evaluateBudgets(base, false)).toEqual({ failures: [], warnings: [], mediaPipeStatus: 'OK' });
    expect(evaluateBudgets(base, true)).toEqual({ failures: [], warnings: [], mediaPipeStatus: 'OK' });
  });

  it('total JS over budget is always a failure', () => {
    const r = evaluateBudgets({ ...base, totalJsGz: 451_000 }, false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/total JS/);
  });

  it('entry chunk over budget: warning by default, failure with --strict', () => {
    const over = { ...base, entryGz: 163_000 };
    expect(evaluateBudgets(over, false).warnings[0]).toMatch(/entry chunk/);
    expect(evaluateBudgets(over, false).failures).toEqual([]);
    expect(evaluateBudgets(over, true).failures[0]).toMatch(/entry chunk/);
  });

  it('MediaPipe in the entry chunk: WARN by default, FAIL with --strict', () => {
    const hit = { ...base, mediaPipeHits: ['index-abc.js: code: mediapipe.tasks.vision'] };
    const lenient = evaluateBudgets(hit, false);
    expect(lenient.mediaPipeStatus).toBe('WARN');
    expect(lenient.failures).toEqual([]);
    expect(lenient.warnings.some((w) => /MediaPipe/.test(w))).toBe(true);
    const strict = evaluateBudgets(hit, true);
    expect(strict.mediaPipeStatus).toBe('FAIL');
    expect(strict.failures.some((f) => /MediaPipe/.test(f))).toBe(true);
  });
});

describe('parseFlags / fmtKb', () => {
  it('parses --strict and --dir', () => {
    expect(parseFlags([])).toEqual({ strict: false, dir: 'dist' });
    expect(parseFlags(['--strict'])).toEqual({ strict: true, dir: 'dist' });
    expect(parseFlags(['--dir', 'out'])).toEqual({ strict: false, dir: 'out' });
  });
  it('formats decimal kilobytes with one decimal (1 kB = 1000 B, like Vite)', () => {
    expect(fmtKb(1000)).toBe('1.0 kB');
    expect(fmtKb(166_706)).toBe('166.7 kB');
  });
});
