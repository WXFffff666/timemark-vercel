import { test, expect } from '@playwright/test';

const USER = { id: 1, username: 'e2e-a11y-user', role: 'admin', mustChangePassword: false };

function installMock(page: import('@playwright/test').Page) {
  page.route('**/api/**', (route) => {
    const req = route.request();
    const cors = {
      'Access-Control-Allow-Origin': 'http://localhost:5173',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const { pathname } = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (pathname === '/api/auth/session') return json({ success: true, data: USER });
    if (pathname === '/api/auth/refresh') return json({ success: false, error: 'Unauthorized' }, 401);
    if (pathname === '/api/auth/turnstile-config') return json({ success: true, data: { siteKey: null, enabled: false } });
    return json({ success: true, data: [] });
  });
}

// v2.43 R26：PageHeader 移动端标题挤没修复的回归探针——
// 390px 下带宽按钮组的页面（medications/contacts）标题必须真实可见（非零宽）。
for (const path of ['/medications', '/contacts']) {
  test(`page header title visible at 390px on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('accessToken', 'e2e-a11y-token'));
    installMock(page);
    await page.goto(path);
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const r = h1?.getBoundingClientRect();
      return { text: h1?.textContent ?? null, w: Math.round(r?.width ?? 0) };
    });
    expect(s.text?.length ?? 0).toBeGreaterThan(0);
    expect(s.w).toBeGreaterThan(60);
  });
}
