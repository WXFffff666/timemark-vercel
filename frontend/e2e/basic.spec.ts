import { test, expect, type Page } from '@playwright/test';

/**
 * 未登录时的壳层行为。
 *
 * 这两条以前不打 API mock，于是「未登录」这件事由**占用 3000 端口的进程**决定：
 * 本机 3000 上跑的是另一个项目，它的 `/api/auth/session` 返回什么，这两条用例就
 * 表现成什么样（实测两种都发生过）。开发模式下 `lib/api.ts` 的 API_BASE 是绝对的
 * `http://localhost:3000/api`，绕过 Vite 代理，所以必须自己把 API 拦下来，
 * 用例才与端口上跑的是谁无关。
 *
 * dev build 跨域请求 3000，因此 mock 必须回 CORS 头（与其它 spec 同一套）。
 */
async function mockUnauthenticated(page: Page) {
  await page.route('**/api/**', (route) => {
    const cors: Record<string, string> = {
      'Access-Control-Allow-Origin': 'http://localhost:5173',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    // 未登录：会话接口一律 401，前端据此清掉本地态并跳 /login
    return route.fulfill({
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Unauthorized' }),
    });
  });
}

test('login page loads', async ({ page }) => {
  await mockUnauthenticated(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /登录|TimeMark/i })).toBeVisible();
});

test('redirects unauthenticated user to login', async ({ page }) => {
  await mockUnauthenticated(page);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});
