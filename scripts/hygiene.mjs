// Standalone hygiene scan for the release step (owner: W10). Same scope and rules as
// tests/unit/repo-hygiene.test.ts but runnable without vitest, e.g. in a pre-push hook:
//   node scripts/hygiene.mjs            # scans the working tree payload
//   node scripts/hygiene.mjs --git      # scans only `git ls-files` (after `git init`)
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const root = process.cwd();
const useGit = process.argv.includes('--git');
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'playwright-report', 'test-results', '.vercel', '.git']);
const ignoredFile = (rel) => /^public\/models\/.*\.(task|tflite)$/.test(rel) || /^public\/wasm\//.test(rel) || /^tests\/fixtures\/.*\.y4m$/.test(rel) || rel === 'package-lock.json';
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.svg', '.yml', '.yaml', '.txt', '.webmanifest', '.mts', '.npmrc', '.gitignore']);
const MEDIA_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const MAX = 5 * 1024 * 1024;
const FORBIDDEN = [
  ['reel host', new RegExp(['insta', 'gram'].join(''), 'i')],
  ['franchise character', new RegExp(['Spider', 'Gwen'].join('-?'), 'i')],
  ['publisher trademark', new RegExp('\\b' + ['Mar', 'vel'].join('') + '\\b')],
  ['creator handle', new RegExp(['pan', 'pan'].join('') + '[_\\w]*', 'i')],
  ['reference material path', /(\.\.\/|^|\s|"|')reference\//m],
];

function files() {
  if (useGit) return execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => !ignoredFile(f));
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (statSync(full).isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue;
        visit(full);
      } else if (!ignoredFile(rel)) out.push(rel);
    }
  };
  visit(root);
  return out;
}

const problems = [];
for (const f of files()) {
  const size = statSync(join(root, f)).size;
  if (size > MAX) problems.push(`${f}: ${(size / 1e6).toFixed(1)} MB > 5 MB`);
  if (MEDIA_EXT.has(extname(f).toLowerCase())) problems.push(`${f}: media file`);
  if (/(^|\/)\.env(\.|$)/.test(f)) problems.push(`${f}: env file`);
  if (TEXT_EXT.has(extname(f)) || TEXT_EXT.has(basename(f))) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const [label, re] of FORBIDDEN) {
      const m = re.exec(text);
      if (m) problems.push(`${f}:${text.slice(0, m.index).split('\n').length}: ${label} (${JSON.stringify(m[0])})`);
    }
  }
}
if (problems.length) {
  console.error('[hygiene] FAILED\n' + problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log(`[hygiene] ok (${useGit ? 'git ls-files' : 'working tree payload'})`);
