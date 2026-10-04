import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Unit-test runner config (owner: W10).
 *  - Node environment: unit tests cover pure logic only. Anything that needs a real DOM,
 *    WebGL2 or MediaStream lives in tests/e2e (Playwright, real Chromium).
 *  - Every module owns tests/unit/<module>/**; tests/unit/*.test.ts (root) and tests/unit/infra are QA/infra.
 *  - tests/unit/render-core/gpu.test.ts boots a Vite server + headless Chromium in its hook and skips
 *    (with a reason) where Chromium is unavailable. On slow machines and in CI run it with
 *    `--hookTimeout 300000 --testTimeout 120000` (see docs/testing.md); the defaults below stay tight
 *    for the pure suites.
 */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'tests/fixtures/**'],
    globals: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/unit-junit.xml' },
    coverage: {
      provider: 'v8',
      enabled: false,
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/__harness__/**', 'src/types/**'],
      reportsDirectory: 'coverage',
    },
  },
});
