import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    // 默认用 Playwright 自带的 Chromium；机器上没下载过（或企业代理挡住下载）时，
    // 用 PLAYWRIGHT_CHANNEL=chrome / msedge 直接跑本机已装的浏览器。
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: {
    command: 'pnpm --filter frontend dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
  },
});
