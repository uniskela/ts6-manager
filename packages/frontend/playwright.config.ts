import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/unit/**'],
  workers: 1,
  // In CI: a line per test so the job log shows progress, and stop after a few
  // failures. A page that breaks for every test otherwise sits out the 30 s
  // timeout 161 times and looks like a hang.
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  maxFailures: process.env.CI ? 5 : undefined,
  use: { baseURL: 'http://127.0.0.1:4175', trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/serve-production.mjs',
    url: 'http://127.0.0.1:4175/login',
    reuseExistingServer: false,
  },
});
