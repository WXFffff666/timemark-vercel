import { test, expect, type Page } from '@playwright/test';

/**
 * Wave-4 dependency modernization guard (todos 29-32):
 * - React 19: no `ReactDOM.render` / legacy-context / key-mount console noise
 * - react-router-dom 7: /dashboard -> /settings -> /calendar -> /todos render
 * - Vite 8: deep-link /todos in a fresh context (SPA fallback shell renders)
 * - Tailwind 4: design tokens + glass utilities survive the CSS-first migration
 */

const USER = { id: 1, username: 'e2e-smoke-user', role: 'admin', mustChangePassword: false };

const FORBIDDEN_CONSOLE = [
  /Warning: ReactDOM\.render/i,
  /legacy context/i,
  /legacy lifecycle/i,
  /Each child in a list should have a unique "key"/i,
  /Encountered two children with the same key/i,
  /Cannot update a component \(`[^`]+`\) while rendering a different component/i,
  /Warning:.*is not a function/i,
];

/** Dev builds call the API cross-origin (http://localhost:3000/api) — fulfilled mocks need CORS headers. */
export async function mockApi(page: Page, token: string) {
  await page.addInitScript((t) => {
    localStorage.setItem('accessToken', t);
  }, token);
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

function collectConsole(page: Page): string[] {
  const logs: string[] = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  return logs;
}

test('router smoke: /dashboard -> /settings -> /calendar -> /todos render without blank screen', async ({ page }) => {
  const logs = collectConsole(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await mockApi(page, 'e2e-smoke-token');

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();

  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();

  await page.goto('/calendar');
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole('heading', { name: '日历' })).toBeVisible();

  await page.goto('/todos');
  await expect(page).toHaveURL(/\/todos$/);
  await expect(page.getByRole('heading', { name: '近期待办' })).toBeVisible();

  // Tailwind 4 token + custom-utility assertions (todos 32 QA scenario).
  const styles = await page.evaluate(() => {
    const glass = document.querySelector('.glass-panel');
    const docStyle = getComputedStyle(document.documentElement);
    return {
      primary: docStyle.getPropertyValue('--primary').trim(),
      radius: docStyle.getPropertyValue('--radius').trim(),
      background: docStyle.getPropertyValue('--background').trim(),
      glassBackdrop: glass ? getComputedStyle(glass).backdropFilter : null,
      glassWidth: glass instanceof HTMLElement ? glass.offsetWidth : 0,
    };
  });
  expect(styles.primary).toBe('221 83% 53%');
  expect(styles.radius).toBe('1rem');
  expect(styles.background).toBe('210 40% 98%');
  expect(styles.glassBackdrop).toContain('blur');
  expect(styles.glassWidth).toBeGreaterThan(0);

  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  for (const line of logs) {
    for (const re of FORBIDDEN_CONSOLE) {
      expect(line, `forbidden React console output: ${line}`).not.toMatch(re);
    }
  }
});

test('deep-link: fresh context directly to /todos renders the SPA shell (vercel.json rewrite guard)', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const logs = collectConsole(page);
  await mockApi(page, 'e2e-smoke-token');

  await page.goto('/todos');
  await expect(page).toHaveURL(/\/todos$/);
  await expect(page.getByRole('heading', { name: '近期待办' })).toBeVisible();
  await expect(page.locator('#root')).not.toBeEmpty();

  for (const line of logs) {
    for (const re of FORBIDDEN_CONSOLE) {
      expect(line, `forbidden React console output: ${line}`).not.toMatch(re);
    }
  }
  await context.close();
});
