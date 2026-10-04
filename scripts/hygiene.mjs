// Standalone hygiene scan for the release step (owner: W10). Same scope and rules as
// tests/unit/repo-hygiene.test.ts but runnable without vitest, e.g. in a pre-push hook:
//   node scripts/hygiene.mjs            # scans the working-tree payload
//   node scripts/hygiene.mjs --git      # scans `git ls-files` (tracked files that still exist on disk)
// Exit code 1 with one `path:line: rule (match)` line per finding; 0 when clean.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const root = process.cwd();
const useGit = process.argv.includes('--git');
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'playwright-report', 'test-results', '.vercel', '.git']);
const ignoredFile = (rel) =>
  /^public\/models\/.*\.(task|tflite)$/.test(rel) || /^public\/wasm\//.test(rel) || /^tests\/fixtures\/.*\.y4m$/.test(rel) || rel === 'package-lock.json' || /^\.probe-/.test(rel);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.svg', '.yml', '.yaml', '.txt', '.webmanifest', '.mts', '.glsl', '.frag', '.vert', '.npmrc', '.gitignore']);
const MEDIA_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const MAX = 5 * 1024 * 1024;

// Every pattern is assembled at runtime so this file does not trip its own scan.
const FORBIDDEN = [
  ['reel host', new RegExp(['insta', 'gram'].join(''), 'i')],
  ['franchise character', new RegExp(['Spider', 'Gwen'].join('-?'), 'i')],
  ['publisher trademark', new RegExp('\\b' + ['Mar', 'vel'].join('') + '\\b')],
  ['creator handle', new RegExp(['pan', 'pan'].join('') + '[_\\w]*', 'i')],
  ['reference material path', /(\.\.\/|^|\s|"|')reference\//m],
];
/** Absolute paths into a developer's home directory; URL path segments like `…/x/home/y` are not matched. */
const HOME_PATH_RE = new RegExp('(?<![\\w.-])' + ['/ho', 'me/'].join('') + '[A-Za-z0-9_.-]+', 'g');
/** Retired internal planning documents: allowed only in the historical notes under docs/handoffs/. */
const RETIRED_DOC_RE = new RegExp(
  [['ten-worker', 'contracts'].join('-'), ['implementation', 'plan\\.md'].join('-'), ['reference', 'analysis'].join('-'), ['lead', 'checklist'].join('-')].join('|'),
  'g',
);

function files() {
  if (useGit) {
    return execSync('git ls-files', { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter((f) => !ignoredFile(f))
      // Deleted in the working tree but not yet committed: nothing to scan.
      .filter((f) => existsSync(join(root, f)));
  }
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).split('\\').join('/');
      if (statSync(full).isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue;
        // Dot-directories other than .github are scratch output, never payload.
        if (name.startsWith('.') && name !== '.github') continue;
        visit(full);
      } else if (!ignoredFile(rel)) out.push(rel);
    }
  };
  visit(root);
  return out.sort();
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const isText = (f) => TEXT_EXT.has(extname(f)) || TEXT_EXT.has(basename(f));

const problems = [];
for (const f of files()) {
  const size = statSync(join(root, f)).size;
  if (size > MAX) problems.push(`${f}: ${(size / 1e6).toFixed(1)} MB > 5 MB`);
  if (MEDIA_EXT.has(extname(f).toLowerCase())) problems.push(`${f}: media file`);
  if (/(^|\/)\.env(\.|$)/.test(f)) problems.push(`${f}: env file`);
  if (/\.log$/i.test(f)) problems.push(`${f}: log file (scratch output; *.log is gitignored)`);
  if (!isText(f)) continue;
  const text = readFileSync(join(root, f), 'utf8');
  for (const [label, re] of FORBIDDEN) {
    const m = re.exec(text);
    if (m) problems.push(`${f}:${lineOf(text, m.index)}: ${label} (${JSON.stringify(m[0])})`);
  }
  for (const m of text.matchAll(HOME_PATH_RE)) problems.push(`${f}:${lineOf(text, m.index)}: absolute home path (${JSON.stringify(m[0])})`);
  if (!f.startsWith('docs/handoffs/')) {
    for (const m of text.matchAll(RETIRED_DOC_RE)) problems.push(`${f}:${lineOf(text, m.index)}: retired planning document (${JSON.stringify(m[0])})`);
  }
}
if (problems.length) {
  console.error(`[hygiene] FAILED — ${problems.length} finding(s)\n` + problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log(`[hygiene] ok (${useGit ? 'git ls-files' : 'working tree payload'})`);
