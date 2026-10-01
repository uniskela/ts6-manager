import { defineConfig } from '@playwright/test';

const isCi = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/unit/**'],
  workers: 1,
  // Cap the whole suite so a stuck browser/SW wait cannot burn the GHA job.
  globalTimeout: isCi ? 8 * 60_000 : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: isCi ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
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
