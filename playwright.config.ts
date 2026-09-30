import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 90_000,
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
