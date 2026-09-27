import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 10 todo 77 – 今日黄历 / 节气 / 生肖 / 星座 card.
 *
 * - /dashboard renders the compact card for TODAY (clock pinned to 2025-10-08,
 *   a 寒露 day, so the assertions are deterministic) with zero console errors.
 * - /calendar day view renders the detail panel (值星 / 冲煞 / 吉神方位).
 */

const USER = { id: 1, username: 'e2e-almanac-user', role: 'admin', mustChangePassword: false };

async function mockApi(page: Page) {
  await page.addInitScript(() => localStorage.setItem('accessToken', 'e2e-almanac-token'));
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const cors: Record<string, string> = {
      'Access-Control-Allow-Origin': 'http://localhost:5173',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const { pathname } = new URL(req.url());
    const json = (body: unknown) =>
      route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (pathname === '/api/auth/session') return json({ success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') return json({ success: true, data: { siteKey: null, enabled: false } });
    return json({ success: true, data: [] });
  });
}

test.describe('今日黄历 card (todo 77)', () => {
  test('dashboard card renders today (寒露 pin) with no console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await mockApi(page);
    await page.clock.setFixedTime(new Date('2025-10-08T04:00:00Z')); // 12:00 Asia/Shanghai
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
    const card = page.getByTestId('almanac-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('今日黄历');
    await expect(card).toContainText('2025-10-08');
    await expect(card).toContainText('二〇二五年八月十七');
    await expect(card).toContainText('乙巳 丙戌 庚戌');
    await expect(card).toContainText('蛇');
    await expect(card).toContainText('天秤');
    await expect(page.getByTestId('almanac-jieqi')).toContainText('今日节气：寒露');
    await expect(page.getByTestId('almanac-yi')).toContainText('祭祀');
    await expect(page.getByTestId('almanac-ji')).toContainText('动土');
    await expect(page.getByTestId('almanac-incomplete')).toHaveCount(0);

    expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('calendar day view renders the almanac detail panel (值星 / 冲煞 / 吉神方位)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await mockApi(page);
    await page.clock.setFixedTime(new Date('2025-10-08T04:00:00Z'));
    await page.goto('/calendar');

    await expect(page.getByRole('heading', { name: '日历' })).toBeVisible();
    await page.locator('[data-date="2025-10-08"]').dblclick();

    const card = page.getByTestId('almanac-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('今日黄历');
    await expect(card).toContainText('值星');
    await expect(card).toContainText('建');
    await expect(card).toContainText('吉神方位');
    await expect(card).toContainText('喜神西北');
    await expect(card).toContainText('今日节气：寒露');

    expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
