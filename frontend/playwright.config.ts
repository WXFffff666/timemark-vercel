import { defineConfig } from '@playwright/test';

// PLAYWRIGHT_DEV_PORT 允许把 dev server（和断言端口）指到别的端口——
// 全链路真连测试用 5189 + VITE_API_BASE=http://localhost:8787/api，避免与
// 常规 mock-API e2e（5173）互相踩。
const devPort = Number(process.env.PLAYWRIGHT_DEV_PORT ?? 5173);

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${devPort}`,
    // 默认用 Playwright 自带的 Chromium；机器上没下载过（或企业代理挡住下载）时，
    // 用 PLAYWRIGHT_CHANNEL=chrome / msedge 直接跑本机已装的浏览器。
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: {
    command:
      devPort === 5173
        ? 'pnpm --filter frontend dev'
        : `pnpm --filter frontend exec vite --port ${devPort} --strictPort`,
    port: devPort,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
  },
});
