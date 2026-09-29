import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 17 todo 150 – 传统历法进阶面板 (择日 / 八字五行 / 生肖·星座 / 彭祖百忌·吉神方位).
 *
 * The panel computes entirely from the pinned `lunar-javascript`; only the auth
 * endpoints are mocked. Assertions are deterministic (pinned ranges / dates) and
 * the 传统文化参考 disclaimer must be visible DOM text.
 */

const USER = { id: 1, username: 'e2e-almanac-advanced-user', role: 'admin', mustChangePassword: false };

async function mockApi(page: Page) {
  await page.addInitScript(() => localStorage.setItem('accessToken', 'e2e-almanac-advanced-token'));
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

test.describe('传统历法进阶面板 (todo 150)', () => {
  test('renders the four sections with the visible disclaimer and no console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await mockApi(page);
    await page.goto('/lunar-holidays');

    await expect(page.getByRole('heading', { name: '农历节日预设' })).toBeVisible();
    const panel = page.getByTestId('almanac-advanced');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('almanac-auspicious')).toBeVisible();
    await expect(page.getByTestId('almanac-bazi')).toBeVisible();
    await expect(page.getByTestId('almanac-daily')).toBeVisible();

    const disclaimer = page.getByTestId('almanac-disclaimer');
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText('传统文化参考，非决策建议');

    expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('黄道吉日 search returns the pinned 嫁娶 dates and degrades an out-of-range year', async ({ page }) => {
    await mockApi(page);
    await page.goto('/lunar-holidays');

    await page.getByLabel('开始日期').fill('2025-10-01');
    await page.getByLabel('结束日期').fill('2025-10-10');
    await page.getByLabel('用途').selectOption('嫁娶');
    await page.getByRole('button', { name: '查询' }).click();

    const results = page.getByTestId('auspicious-results');
    await expect(results).toContainText('2025-10-02');
    await expect(results).toContainText('2025-10-03');
    await expect(results).toContainText('2025-10-08');
    await expect(results).toContainText('已扫描 10 天');

    await page.getByLabel('开始日期').fill('1800-01-01');
    await page.getByLabel('结束日期').fill('1800-01-31');
    await page.getByRole('button', { name: '查询' }).click();
    await expect(page.getByTestId('auspicious-error')).toContainText('数据不可用');
    await expect(page.getByTestId('auspicious-results')).toHaveCount(0);
  });

  test('八字 排盘 renders pinned pillars and rejects a malformed birth input', async ({ page }) => {
    await mockApi(page);
    await page.goto('/lunar-holidays');

    await page.getByLabel('出生时间').fill('2000-01-15 08:30');
    await page.getByRole('button', { name: '排盘' }).click();
    const bazi = page.getByTestId('bazi-result');
    await expect(bazi).toContainText('己卯');
    await expect(bazi).toContainText('甲辰');
    await expect(bazi).toContainText('日主 壬');

    await page.getByLabel('出生时间').fill('nope');
    await page.getByRole('button', { name: '排盘' }).click();
    await expect(page.getByTestId('bazi-error')).toContainText('出生时间格式无效');
    await expect(page.getByTestId('bazi-result')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('NaN');
  });
});
