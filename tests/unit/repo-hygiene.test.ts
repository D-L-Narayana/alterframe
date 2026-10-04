/**
 * Repo hygiene (owner: W10). Scans the TRACKED / PUBLIC payload of the app — i.e. what would be
 * committed and deployed — not node_modules, build output, generated fixtures, fetched models or
 * copied wasm (all gitignored). See docs/release.md for the scope rationale.
 *
 * Forbidden strings are assembled at runtime so this file does not trip its own scan.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { APP_ROOT } from './infra/paths';

/** Directories that are never part of the payload (mirrors .gitignore). */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'playwright-report', 'test-results', '.vercel', '.git', 'wasm']);
const IGNORED_FILE = (rel: string): boolean =>
  /^public\/models\/.*\.(task|tflite)$/.test(rel) ||
  /^tests\/fixtures\/.*\.y4m$/.test(rel) ||
  rel === 'package-lock.json' ||
  // Lead's local probe scripts/pages (`.probe-*`, gitignored, never part of the payload).
  /^\.probe-/.test(rel);

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.svg', '.yml', '.yaml', '.txt', '.webmanifest', '.mts', '.glsl', '.frag', '.vert', '.npmrc', '.gitignore']);
const MEDIA_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function walkPayload(root = APP_ROOT): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).split('\\').join('/');
      const st = statSync(full);
      if (st.isDirectory()) {
        // `wasm` is only ignored under public/.
        if (IGNORED_DIRS.has(name) && (name !== 'wasm' || rel === 'public/wasm')) continue;
        // Dot-directories other than .github are scratch output (e.g. a worker's .w3-dist-check/), never payload.
        if (name.startsWith('.') && name !== '.github') continue;
        visit(full);
      } else if (!IGNORED_FILE(rel)) {
        out.push(rel);
      }
    }
  };
  visit(root);
  return out.sort();
}

const isText = (rel: string): boolean => TEXT_EXT.has(extname(rel)) || TEXT_EXT.has(basename(rel));

/** Assembled at runtime: creator handle, franchise/trademark names, the reel URL host. */
const FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: 'reel host', re: new RegExp(['insta', 'gram'].join(''), 'i') },
  { label: 'franchise character', re: new RegExp(['Spider', 'Gwen'].join('-?'), 'i') },
  { label: 'publisher trademark', re: new RegExp('\\b' + ['Mar', 'vel'].join('') + '\\b') },
  { label: 'creator handle', re: new RegExp(['pan', 'pan'].join('') + '[_\\w]*', 'i') },
  { label: 'reference material path', re: /\breference\/(frames|thumbs|sheets|reel|detail|frame-inventory)/ },
  { label: 'reference folder path', re: /(\.\.\/|^|\s|"|')reference\//m },
];

/**
 * Retired internal planning documents (never part of this repository). Names are assembled at
 * runtime so this file does not trip its own scan. Historical build notes under docs/handoffs/
 * are exempt; everywhere else the references must go.
 */
const RETIRED_DOCS: string[] = [
  ['ten-worker', 'contracts'].join('-'),
  ['implementation', 'plan.md'].join('-'),
  ['reference', 'analysis'].join('-'),
  ['lead', 'checklist'].join('-'),
];
const RETIRED_DOC_RE = new RegExp(RETIRED_DOCS.map((s) => s.replace(/\./g, '\\.')).join('|'));
/** Absolute paths into a developer's home directory (private workspace layout); URL path segments like `…/x/home/y` are not matched. */
const HOME_PATH_RE = new RegExp('(?<![\\w.-])' + ['/ho', 'me/'].join('') + '[A-Za-z0-9_.-]+');

/** Every match of `re` in `text` as `{ line, match }` (1-based lines). */
function findAll(text: string, re: RegExp): { line: number; match: string }[] {
  const out: { line: number; match: string }[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  text.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(g)) out.push({ line: i + 1, match: m[0] });
  });
  return out;
}

const payload = walkPayload();

describe('repo hygiene — payload scope', () => {
  it('scans a non-trivial payload (sanity)', () => {
    expect(payload.length).toBeGreaterThan(20);
    expect(payload).toContain('package.json');
    expect(payload.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(payload.some((f) => f.startsWith('public/wasm/'))).toBe(false);
    expect(payload.some((f) => f.endsWith('.y4m'))).toBe(false);
  });

  it('.gitignore excludes generated/fetched binaries and test output', () => {
    const gi = readFileSync(join(APP_ROOT, '.gitignore'), 'utf8');
    for (const entry of ['node_modules', 'dist', 'public/wasm', 'public/models/*.task', 'public/models/*.tflite', 'tests/fixtures/*.y4m', 'test-results', 'playwright-report', '.vercel']) {
      expect(gi, `.gitignore must list ${entry}`).toContain(entry);
    }
  });
});

describe('repo hygiene — payload content', () => {
  it(`contains no file larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`, () => {
    const big = payload.filter((f) => statSync(join(APP_ROOT, f)).size > MAX_FILE_BYTES);
    expect(big).toEqual([]);
  });

  it('contains no video/audio media files', () => {
    const media = payload.filter((f) => MEDIA_EXT.has(extname(f).toLowerCase()));
    expect(media).toEqual([]);
  });

  it('contains no .env files', () => {
    const env = payload.filter((f) => /(^|\/)\.env(\.|$)/.test(f));
    expect(env).toEqual([]);
  });

  it('contains no *.log files (dev-server / harness logs are scratch output, gitignored)', () => {
    const logs = payload.filter((f) => /\.log$/i.test(f));
    expect(logs, 'delete stray log files; *.log is in .gitignore').toEqual([]);
  });

  it('contains no absolute paths into a home directory in text files', () => {
    const hits: string[] = [];
    for (const f of payload) {
      if (!isText(f)) continue;
      for (const { line, match } of findAll(readFileSync(join(APP_ROOT, f), 'utf8'), HOME_PATH_RE)) hits.push(`${f}:${line} — absolute home path (${JSON.stringify(match)})`);
    }
    expect(hits, `private workspace paths must not be committed:\n${hits.join('\n')}`).toEqual([]);
  });

  it('references no retired internal planning documents outside docs/handoffs/ (historical notes only)', () => {
    const hits: string[] = [];
    for (const f of payload) {
      if (!isText(f) || f.startsWith('docs/handoffs/')) continue;
      for (const { line, match } of findAll(readFileSync(join(APP_ROOT, f), 'utf8'), RETIRED_DOC_RE)) hits.push(`${f}:${line} — retired planning document (${JSON.stringify(match)})`);
    }
    expect(hits, `remove references to retired planning documents (they are not part of this repository):\n${hits.join('\n')}`).toEqual([]);
  });

  it('contains no forbidden strings (reel host, franchise names, creator handle, reference paths)', () => {
    const hits: string[] = [];
    for (const f of payload) {
      if (!isText(f)) continue;
      const text = readFileSync(join(APP_ROOT, f), 'utf8');
      for (const { label, re } of FORBIDDEN) {
        const m = re.exec(text);
        if (m) {
          const line = text.slice(0, m.index).split('\n').length;
          hits.push(`${f}:${line} — ${label} (${JSON.stringify(m[0])})`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('contains no raster screenshots outside our own visual baselines', () => {
    const rasters = payload.filter((f) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f));
    // Allowed: Playwright baselines, README images and worker handoff screenshots of OUR harnesses.
    const foreign = rasters.filter((f) => !f.startsWith('tests/e2e/__screenshots__/') && !f.startsWith('docs/images/') && !f.startsWith('docs/handoffs/'));
    expect(foreign, 'raster images must be our own screenshots (tests/e2e/__screenshots__, docs/images, docs/handoffs)').toEqual([]);
  });
});

describe('repo hygiene — source policy (src/**)', () => {
  const srcFiles = payload.filter((f) => f.startsWith('src/') && /\.(ts|tsx)$/.test(f));
  /** Source with block and line comments removed (policy checks target code, not prose). */
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const read = (f: string): string => stripComments(readFileSync(join(APP_ROOT, f), 'utf8'));

  it('uses no persistent browser storage (project override: settings are memory-only)', () => {
    const storage = /\b(localStorage|sessionStorage)\s*[.[]|\bindexedDB\s*\.|\bcaches\s*\.open\s*\(/;
    const zustandPersist = /from\s+['"]zustand\/middleware['"][\s\S]*\bpersist\b|\bpersist\b[\s\S]*from\s+['"]zustand\/middleware['"]/;
    const hits = srcFiles.filter((f) => storage.test(read(f)) || zustandPersist.test(read(f)));
    expect(hits, 'no localStorage/sessionStorage/indexedDB/CacheStorage/zustand persist middleware in src').toEqual([]);
  });

  it('has no eval / Function constructor / innerHTML sinks', () => {
    const re = /\beval\s*\(|new\s+Function\s*\(|dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/;
    const hits = srcFiles.filter((f) => re.test(read(f)));
    expect(hits).toEqual([]);
  });

  it('UI code does not reach for window.__alterframe (dev-only handle)', () => {
    const hits = srcFiles.filter((f) => (f.startsWith('src/app/') || f.startsWith('src/ui/') || f.startsWith('src/state/')) && /window\.__alterframe\b/.test(read(f)));
    expect(hits).toEqual([]);
  });

  /** Files whose own source references the compile-time gate. */
  const ENV_GATE = /import\.meta\.env\.(DEV|VITE_E2E)/;
  const resolveImport = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
    else if (spec.startsWith('.')) base = join(from, '..', spec).split('\\').join('/');
    else return null;
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (payload.includes(cand)) return cand;
    return null;
  };
  /** A file is gated if it references the env flags itself or imports a module that does (e.g. runtime/devBridge). */
  const isGated = (f: string): boolean => {
    const text = read(f);
    if (ENV_GATE.test(text)) return true;
    const specs = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    return specs.some((spec) => {
      const target = resolveImport(f, spec);
      return target !== null && target !== f && ENV_GATE.test(read(target));
    });
  };

  it('dev hooks are gated: files that expose __alterframe/injectTracking use import.meta.env.DEV / VITE_E2E (directly or via a gate module)', () => {
    const exposing = srcFiles.filter((f) => !f.startsWith('src/types/') && !/__harness__/.test(f) && /window\.__alterframe\s*=|__alterframe\s*=\s*handle|injectTracking\s*[:(=]/.test(read(f)));
    expect(exposing.length, 'the runtime is expected to expose the (gated) hooks somewhere').toBeGreaterThan(0);
    const ungated = exposing.filter((f) => !isGated(f));
    expect(ungated, 'expose test hooks only behind import.meta.env.DEV / VITE_E2E').toEqual([]);
  });

  it('production code never reads the mockTracking query flag without a DEV/VITE_E2E guard', () => {
    const hits = srcFiles.filter((f) => /mockTracking/.test(read(f)) && !f.startsWith('src/types/') && !/__harness__/.test(f) && !isGated(f));
    expect(hits).toEqual([]);
  });

  it('harness folders are not imported by application code', () => {
    const hits = srcFiles.filter((f) => !/__harness__/.test(f) && /from\s+['"][^'"]*__harness__/.test(read(f)));
    expect(hits).toEqual([]);
  });

  it('models/wasm are loaded from our origin, not a CDN', () => {
    const hits = srcFiles.filter((f) => /cdn\.jsdelivr\.net|unpkg\.com|storage\.googleapis\.com/.test(read(f)));
    expect(hits, 'runtime must use /models and /wasm (same-origin)').toEqual([]);
  });
});

describe('repo hygiene — licences and attribution', () => {
  it('LICENSE is MIT with the project holder', () => {
    const lic = readFileSync(join(APP_ROOT, 'LICENSE'), 'utf8');
    expect(lic).toMatch(/MIT License/);
    expect(lic).toMatch(/D-L-Narayana/);
  });

  it('NOTICE.md attributes MediaPipe (Apache-2.0) and Inter (OFL 1.1) with source URLs', () => {
    const notice = readFileSync(join(APP_ROOT, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/MediaPipe/);
    expect(notice).toMatch(/Apache-2\.0|Apache License, Version 2\.0/);
    expect(notice).toMatch(/Inter/);
    expect(notice).toMatch(/OFL|Open Font License/);
    expect(notice).toMatch(/https:\/\/[^\s)]+/);
  });

  it('third-party licence files that ship in public/ are kept', () => {
    // If W3 commits public/models/README.md it must carry licence + source URLs (contract §W3.6).
    const readme = join(APP_ROOT, 'public/models/README.md');
    if (existsSync(readme)) {
      const text = readFileSync(readme, 'utf8');
      expect(text).toMatch(/Apache/);
      expect(text).toMatch(/https:\/\//);
    }
  });
});
