import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/unit/**'],
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4175', trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/serve-production.mjs',
    url: 'http://127.0.0.1:4175/login',
    reuseExistingServer: false,
  },
});
