import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
  },
  webServer: {
    command: 'pnpm --filter frontend dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
  },
});
