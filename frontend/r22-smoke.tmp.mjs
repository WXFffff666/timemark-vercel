import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5189';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

const loginRes = await context.request.post(BASE + '/api/auth/login', {
  data: { username: 'admin', password: 'devadmin123' },
  headers: { 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5189' },
});
console.log('login:', loginRes.status());
if (!loginRes.ok()) process.exit(1);

const page = await context.newPage();
await page.goto(BASE + '/analytics', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const card = await page.evaluate(() => {
  const t = document.body.innerText;
  return {
    title: t.includes('生活域概览'),
    chips: ['联系人', '物品', '保养计划', '进行中目标', '活跃习惯', '到期项目'].every((k) => t.includes(k)),
    errorBoundary: t.includes('出了问题'),
  };
});
console.log('life domains card:', JSON.stringify(card));

// ApiPortal OpenAPI 卡
await page.goto(BASE + '/api-portal', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const apiCard = await page.evaluate(() => {
  const t = document.body.innerText;
  return { openapi: t.includes('OpenAPI 3.1 规范'), download: t.includes('下载 .json'), link: t.includes('/api/v1/openapi.json') };
});
console.log('api portal openapi card:', JSON.stringify(apiCard));

await browser.close();
console.log('R22-SMOKE-DONE');
