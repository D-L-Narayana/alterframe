/**
 * CI / toolchain consistency (owner: W10): the Node version used in CI and declared in
 * package.json engines must satisfy the engine ranges of the INSTALLED Vite / ESLint / Vitest.
 * (Vite 8 needs ^20.19.0 || >=22.12.0 — "Node 20" alone is not enough.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from './paths';

const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { engines: { node: string }; scripts: Record<string, string>; devDependencies: Record<string, string>; dependencies: Record<string, string> };
const engineOf = (name: string): string => (JSON.parse(readFileSync(join(APP_ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { engines?: { node?: string } }).engines?.node ?? '*';
const ci = readFileSync(join(APP_ROOT, '.github/workflows/ci.yml'), 'utf8');

/** Minimal semver-range satisfaction for `^x.y.z`, `>=x.y.z`, `||` unions and `*`. */
function satisfies(version: string, range: string): boolean {
  const v = version.split('.').map(Number) as [number, number, number];
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return range.split('||').some((part) => {
    const clauses = part.trim().split(/\s+/).filter(Boolean);
    return clauses.every((c) => {
      if (c === '*') return true;
      const m = /^(\^|>=|>|<=|<|~)?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(c);
      if (!m) return false;
      const op = m[1] ?? '';
      const t = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
      switch (op) {
        case '^':
          return cmp(v, t) >= 0 && v[0] === t[0];
        case '~':
          return cmp(v, t) >= 0 && v[0] === t[0] && v[1] === t[1];
        case '>=':
          return cmp(v, t) >= 0;
        case '>':
          return cmp(v, t) > 0;
        case '<=':
          return cmp(v, t) <= 0;
        case '<':
          return cmp(v, t) < 0;
        default:
          return cmp(v, t) === 0;
      }
    });
  });
}

/** CI pins major.minor; model it as the first patch of that minor (the lowest actions/setup-node could resolve). */
const ciNodeVersion = (): string => {
  const m = /NODE_VERSION:\s*'?(\d+)(?:\.(\d+))?(?:\.(\d+))?'?/.exec(ci);
  expect(m, 'ci.yml declares NODE_VERSION').toBeTruthy();
  expect(m![2], 'NODE_VERSION must pin at least major.minor (a bare major is not deterministic against engine ranges)').toBeDefined();
  return `${m![1]}.${m![2]}.${m![3] ?? 0}`;
};

describe('toolchain / CI consistency', () => {
  it('semver helper sanity', () => {
    expect(satisfies('20.20.1', '^20.19.0 || >=22.12.0')).toBe(true);
    expect(satisfies('20.18.0', '^20.19.0 || >=22.12.0')).toBe(false);
    expect(satisfies('22.12.0', '^20.19.0 || >=22.12.0')).toBe(true);
    expect(satisfies('22.11.0', '^20.19.0 || >=22.12.0')).toBe(false);
    expect(satisfies('24.1.0', '^20.19.0 || ^22.13.0 || >=24')).toBe(true);
  });

  it('CI Node version satisfies installed vite, eslint, vitest and @playwright/test engines', () => {
    const v = ciNodeVersion();
    for (const dep of ['vite', 'eslint', 'vitest', '@playwright/test']) {
      expect(satisfies(v, engineOf(dep)), `${dep} engines ${engineOf(dep)} vs CI node ${v}`).toBe(true);
    }
  });

  it('package.json engines.node is at least as strict as vite’s and eslint’s requirement', () => {
    // Every lower bound we accept must itself satisfy the tool ranges.
    const ours = pkg.engines.node;
    for (const probe of ['20.19.0', '22.12.0', '22.13.0', '24.0.0']) {
      if (satisfies(probe, ours)) expect(satisfies(probe, engineOf('vite')), `node ${probe} allowed by engines but rejected by vite`).toBe(true);
    }
    expect(satisfies('20.18.0', ours), 'Node 20.18 is rejected by Vite 8 and must be rejected by engines').toBe(false);
    // The current sandbox runtime must also be allowed.
    expect(satisfies(process.versions.node, ours)).toBe(true);
  });

  it('CI runs typecheck, lint, unit tests, build with dist verification, fixture generation and Playwright', () => {
    for (const step of ['npm ci', 'npm run typecheck', 'npm run lint', 'npm test', 'npm run build', 'playwright install', 'npm run fixture', 'npx playwright test', 'upload-artifact']) {
      expect(ci, `ci.yml runs: ${step}`).toContain(step);
    }
    expect(ci).toMatch(/cache: npm/);
    expect(ci, 'Node 22 line pinned (Vercel project setting: 22.x)').toMatch(/NODE_VERSION:\s*'22\.\d+'/);
  });

  it('CI build job enforces the bundle report in strict mode (total + entry budgets, MediaPipe-free entry chunk)', () => {
    expect(ci).toContain('node scripts/bundle-report.mjs --strict');
  });

  it('CI e2e job runs the GPU pixel suite with Chromium installed and the long harness timeouts', () => {
    const e2eJob = ci.slice(ci.indexOf('\n  e2e:'), ci.indexOf('\n  prod-gate:'));
    expect(e2eJob).toContain('playwright install');
    expect(e2eJob).toContain('npx vitest run tests/unit/render-core/gpu.test.ts --hookTimeout 300000 --testTimeout 120000');
    expect(e2eJob.indexOf('playwright install'), 'Chromium is installed before the GPU suite runs').toBeLessThan(e2eJob.indexOf('gpu.test.ts'));
  });

  it('CI caches the generated fixture clips keyed on the generator', () => {
    expect(ci).toContain('path: tests/fixtures/*.y4m');
    expect(ci).toMatch(/key: fixture-y4m-\$\{\{ hashFiles\('tests\/fixtures\/make-fixture\.mjs'\) \}\}/);
  });

  it('CI prod-gate job serves the built dist with the vercel.json semantics and runs the production gate', () => {
    const job = ci.slice(ci.indexOf('\n  prod-gate:'), ci.indexOf('\n  audit:'));
    expect(job).toMatch(/needs:\s*\[build\]/);
    expect(job).toContain('download-artifact');
    expect(job).toContain('name: dist');
    expect(job).toContain('playwright install');
    expect(job).toContain('node scripts/with-server.mjs');
    expect(job).toContain('npm run test:prod-gate');
  });

  it('CI audit job is advisory: npm audit on runtime deps, high+ only, continue-on-error', () => {
    const job = ci.slice(ci.indexOf('\n  audit:'));
    expect(job).toContain('npm audit --omit=dev --audit-level=high');
    expect(job).toMatch(/continue-on-error:\s*true/);
  });

  it('package scripts: lint uses flat config (no --ext), build verifies dist, e2e regenerates the fixture, prod gate scripts', () => {
    expect(pkg.scripts['lint']).toBe('eslint .');
    expect(pkg.scripts['postbuild']).toContain('verify-dist');
    expect(pkg.scripts['prebuild']).toContain('fetch-models');
    expect(pkg.scripts['prebuild']).toContain('copy-wasm');
    expect(pkg.scripts['postinstall']).toContain('copy-wasm');
    expect(pkg.scripts['pretest:e2e']).toContain('make-fixture');
    expect(pkg.scripts['test']).toBe('vitest run');
    expect(pkg.scripts['qa']).toContain('6220');
    expect(pkg.scripts['serve:dist']).toBe('node scripts/serve-dist.mjs --port 4173');
    expect(pkg.scripts['test:prod-gate']).toContain('tests/e2e/production-gate.spec.ts');
  });

  it('with-server exports E2E_PROD_URL and E2E_BASE_URL by default (what test:prod-gate needs; no Vite dev server boot)', () => {
    const src = readFileSync(join(APP_ROOT, 'scripts/with-server.mjs'), 'utf8');
    expect(src).toContain("exportVars: ['E2E_PROD_URL', 'E2E_BASE_URL']");
    expect(src).toContain('node scripts/serve-dist.mjs --port');
  });

  it('only the contract-listed dev dependencies were added (W10 is the sole package.json editor)', () => {
    const allowedDev = ['@axe-core/playwright', '@eslint/js', '@playwright/test', '@types/node', '@types/react', '@types/react-dom', '@vitejs/plugin-react', 'eslint', 'eslint-plugin-react-hooks', 'globals', 'typescript', 'typescript-eslint', 'vite', 'vitest'];
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(allowedDev.sort());
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@fontsource/inter', '@mediapipe/tasks-vision', 'react', 'react-dom', 'zustand']);
  });

  it('lockfile is in sync with package.json (every declared dep is in the lock)', () => {
    const lock = JSON.parse(readFileSync(join(APP_ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    for (const dep of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]) {
      expect(lock.packages[`node_modules/${dep}`], `${dep} in package-lock`).toBeTruthy();
    }
  });
});
