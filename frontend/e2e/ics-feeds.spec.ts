import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Checkbox 89 - Settings management for public ICS subscription feeds.
 *
 * Covers: create (URL shown once) -> copy -> revoke; a malformed profile id is
 * rejected client-side without a POST; and the checkbox-84 browser Web Push
 * toggle is still rendered in the same page (composition, not replacement).
 */

const USER = { id: 1, username: 'e2e-ics-feed-user', role: 'admin', mustChangePassword: false };

interface FeedRecord {
  id: number;
  name: string;
  filter: { type: string; value: string | number };
  createdAt: string;
  lastAccessAt: string | null;
  revokedAt: string | null;
}

interface FeedState {
  feeds: FeedRecord[];
  createdToken: string | null;
  postCount: number;
  revokeCalls: string[];
  dialogs: string[];
  lastCreateBody: { name?: string; filter?: unknown } | null;
}

async function setup(page: Page): Promise<FeedState> {
  const state: FeedState = {
    feeds: [],
    createdToken: null,
    postCount: 0,
    revokeCalls: [],
    dialogs: [],
    lastCreateBody: null,
  };

  await page.addInitScript(() => {
    localStorage.setItem('accessToken', 'e2e-ics-feed-token');
  });

  page.on('dialog', (dialog) => {
    state.dialogs.push(dialog.message());
    void dialog.accept();
  });

  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': 'http://localhost:5173',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const { pathname } = new URL(req.url());

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') return json(route, { success: true, data: { siteKey: null, enabled: false } });
    if (pathname === '/api/config' && method === 'GET') {
      return json(route, { success: true, data: { timezone: 'Asia/Shanghai', reminder_emails: [], alert_account_ids: [] } });
    }
    if (pathname === '/api/config/accounts') return json(route, { success: true, data: [] });
    if (pathname === '/api/email-logs') return json(route, { success: true, data: [] });
    if (pathname === '/api/calendar/integrations') return json(route, { success: true, data: {} });
    if (pathname === '/api/config/notification-advanced') return json(route, { success: true, data: {} });
    if (pathname === '/api/calendar/google-oauth/status') return json(route, { success: true, data: { configured: false, connected: false } });
    if (pathname === '/api/profiles') return json(route, { success: true, data: [] });
    if (pathname === '/api/inbox') return json(route, { success: true, data: [], pagination: { unreadCount: 0 } });
    if (pathname === '/api/config/digest' && method === 'GET') return json(route, { success: true, data: {} });

    if (pathname === '/api/calendar/ics-feeds' && method === 'GET') {
      return json(route, { success: true, data: { feeds: state.feeds } });
    }
    if (pathname === '/api/calendar/ics-feeds' && method === 'POST') {
      state.postCount += 1;
      const body = (req.postDataJSON() ?? {}) as { name?: string; filter: { type: string; value: string | number } };
      state.lastCreateBody = body;
      state.createdToken = 'tok_e2e_' + 'a'.repeat(32);
      const feed: FeedRecord = {
        id: state.feeds.length + 1,
        name: body.name || `${body.filter.type} ${String(body.filter.value)}`,
        filter: body.filter,
        createdAt: '2026-09-28T00:00:00.000Z',
        lastAccessAt: null,
        revokedAt: null,
      };
      state.feeds.push(feed);
      return json(
        route,
        {
          success: true,
          data: { ...feed, url: `https://timemark.example.com/api/public/ics/${state.createdToken}.ics` },
        },
        201,
      );
    }
    const revoke = pathname.match(/^\/api\/calendar\/ics-feeds\/(\d+)$/);
    if (revoke && method === 'DELETE') {
      state.revokeCalls.push(revoke[1]);
      const feed = state.feeds.find((f) => f.id === Number(revoke[1]));
      if (feed) feed.revokedAt = '2026-09-28T01:00:00.000Z';
      return json(route, { success: true });
    }

    return json(route, { success: true, data: [] });
  });

  return state;
}

test('creates a public ICS feed, shows the URL once, copies it and revokes it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const state = await setup(page);

  await page.goto('/settings');
  const section = page.getByTestId('ics-feeds-section');
  await expect(section).toBeVisible();
  await expect(section.getByText('公开订阅源（按分类 / 档案 / 联系人）')).toBeVisible();

  await section.getByLabel('公开订阅源名称').fill('生日订阅');
  await section.getByLabel('公开订阅源筛选值').fill('birthday');
  await section.getByTestId('ics-feed-create').click();

  await expect(section.getByTestId('ics-feed-row-1')).toContainText('生日订阅');
  const url = section.getByTestId('ics-feed-url');
  await expect(url).toBeVisible();
  await expect(url).toContainText('/api/public/ics/tok_e2e_');
  await expect(url).toContainText('.ics');
  expect(state.lastCreateBody).toEqual({ name: '生日订阅', filter: { type: 'category', value: 'birthday' } });

  // Copy: the clipboard branch alerts "已复制" (a failure would alert 复制失败).
  await section.getByLabel('复制公开订阅 URL').click();
  await expect.poll(() => state.dialogs.some((m) => m.includes('已复制'))).toBe(true);
  await expect.poll(() => state.dialogs.some((m) => m.includes('复制失败'))).toBe(false);

  // Revoke: confirm dialog accepted, row flips to 已撤销 and the DELETE is user-scoped.
  await section.getByLabel('撤销订阅源 生日订阅').click();
  await expect(section.getByTestId('ics-feed-row-1')).toContainText('已撤销');
  expect(state.revokeCalls).toEqual(['1']);
});

test('rejects a non-numeric profile id client-side without any POST, and keeps the Web Push toggle', async ({ page }) => {
  const state = await setup(page);

  await page.goto('/settings');
  const section = page.getByTestId('ics-feeds-section');
  await expect(section).toBeVisible();

  await section.getByLabel('公开订阅源筛选类型').selectOption('profile');
  await section.getByLabel('公开订阅源筛选值').fill('abc');
  await section.getByTestId('ics-feed-create').click();

  await expect.poll(() => state.dialogs.some((m) => m.includes('正整数'))).toBe(true);
  expect(state.postCount).toBe(0);

  // Checkbox 84 must still be composed into the same page.
  await expect(page.getByText('浏览器推送')).toBeVisible();
  await expect(page.getByText('浏览器通知')).toBeVisible();
});
