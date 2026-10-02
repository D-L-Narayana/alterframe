import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath, URL } from 'node:url';

/**
 * End-to-end config (owner: W10).
 *
 * The suite runs against the Vite DEV server on purpose: the runtime exposes the
 * `window.__alterframe` handle and the `injectTracking` test hook only in dev
 * (`import.meta.env.DEV`); production builds never read `?mockTracking=1`.
 *
 * Chromium is started with a fake camera fed from the GENERATED fixture
 * tests/fixtures/hands.y4m (`npm run fixture`). The file is >5 MB and gitignored;
 * `pretest:e2e` regenerates it when missing.
 */
// Port 6220 is W10's reserved dev/QA port (workers use 6211–6220); `npm run qa` serves it.
const PORT = Number(process.env.E2E_PORT ?? 6220);
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const fixture = fileURLToPath(new URL('./tests/fixtures/hands.y4m', import.meta.url));
const stillFixture = fileURLToPath(new URL('./tests/fixtures/hands-still.y4m', import.meta.url));
const isCI = Boolean(process.env.CI);

/** Chromium flags: fake camera fed from a Y4M file + software WebGL2 that works headless. */
function chromiumArgs(videoFile: string): string[] {
  return [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${videoFile}`,
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ];
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled', caret: 'hide' },
  },
  outputDir: 'test-results/e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  reporter: isCI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['junit', { outputFile: 'test-results/e2e-junit.xml' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    permissions: ['camera'],
    colorScheme: 'dark',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    launchOptions: { args: chromiumArgs(fixture) },
  },
  projects: [
    // Moving fixture: everything except the visual baselines.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /visual\.spec\.ts$/ },
    // Static 1-s clip (same scene, t = 5 s) so screenshots are deterministic.
    { name: 'visual', testMatch: /visual\.spec\.ts$/, use: { ...devices['Desktop Chrome'], launchOptions: { args: chromiumArgs(stillFixture) } } },
  ],
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: `npm run dev -- --port ${PORT} --strictPort --host 127.0.0.1`,
          url: `${E2E_BASE_URL}/`,
          reuseExistingServer: !isCI,
          timeout: 180_000,
          stdout: 'ignore' as const,
          stderr: 'pipe' as const,
        },
      }),
});
