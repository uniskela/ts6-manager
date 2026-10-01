import { defineConfig } from '@playwright/test';

const isCi = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/unit/**'],
  workers: 1,
  // Keep below the GHA step timeout-minutes (8) so Playwright can finish and
  // emit its report before the runner kills the step.
  globalTimeout: isCi ? 7 * 60_000 : undefined,
  timeout: 30_000,
  reporter: isCi ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
    launchOptions: isCi
      ? {
          // Shared-memory Chromium hangs are a known GHA flake without this.
          args: ['--disable-dev-shm-usage'],
        }
      : undefined,
  },
  webServer: {
    command: 'node tests/serve-production.mjs',
    url: 'http://127.0.0.1:4175/login',
    reuseExistingServer: !isCi,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
