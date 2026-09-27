import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * 全局档案切换器（D5，checkbox 70）端到端。
 *
 * happy: 默认「全部档案」显示全部事件 → 切到「小明」只剩小明的档案事件 →
 *        刷新后选择仍在（localStorage 按设备持久化），且请求确实带了 profileId。
 * failure: 切到一个没有任何事件的「花花」档案 → 展示空状态，切换器仍可用
 *        （切回「全部档案」事件重新出现）。
 */

const USER = { id: 1, username: 'e2e-profile-user', role: 'admin', mustChangePassword: false };

interface EventRow {
  id: string;
  user_id: string;
  name: string;
  type: string;
  date: string;
  calendarType: string;
  profile_id: number | null;
  reminderConfig: Record<string, unknown>;
}

function event(id: string, name: string, profileId: number | null): EventRow {
  return {
    id,
    user_id: '1',
    name,
    type: 'birthday',
    date: '2026-10-01',
    calendarType: 'gregorian',
    profile_id: profileId,
    reminderConfig: { enabled: true, daysBeforeList: [1], emailRecipients: [], reminderTimes: ['09:00'] },
  };
}

const PROFILES = [
  { id: 11, user_id: 1, name: '我', relation: null, kind: 'self', avatar_emoji: null },
  { id: 12, user_id: 1, name: '小明', relation: '儿子', kind: 'family', avatar_emoji: null },
  { id: 13, user_id: 1, name: '花花', relation: null, kind: 'pet', avatar_emoji: '🐱' },
];

async function setup(page: Page): Promise<{ requestedProfileIds: Array<string | null> }> {
  const rows = [event('1', '妈妈生日', 11), event('2', '小明疫苗', 12)];
  const requestedProfileIds: Array<string | null> = [];

  await page.addInitScript(({ token }) => {
    localStorage.setItem('accessToken', token);
    // Clear the persisted profile once per tab (not on every reload) so the
    // persistence assertion below actually observes localStorage surviving reload.
    if (!sessionStorage.getItem('e2e-profile-init')) {
      localStorage.removeItem('timemark.profileId');
      sessionStorage.setItem('e2e-profile-init', '1');
    }
  }, { token: 'e2e-profile-token' });

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
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const pathname = url.pathname;

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') {
      return json(route, { success: true, data: { siteKey: null, enabled: false } });
    }
    if (pathname === '/api/profiles') {
      return json(route, { success: true, data: PROFILES });
    }
    if (pathname === '/api/events' && req.method() === 'GET') {
      const profileId = url.searchParams.get('profileId');
      requestedProfileIds.push(profileId);
      const list = profileId ? rows.filter((row) => String(row.profile_id) === profileId) : rows;
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 50, total: list.length, totalPages: 1 } });
    }
    if (pathname === '/api/inbox') {
      return json(route, { success: true, data: [], pagination: { unreadCount: 0 } });
    }
    if (pathname === '/api/features/conflicts') return json(route, { success: true, data: [] });
    if (pathname === '/api/todos/completions') return json(route, { success: true, data: [] });
    if (pathname === '/api/time/status') {
      return json(route, { success: true, data: { timezone: 'Asia/Shanghai', offset: 480, synced: true, calendarVerify: { ok: true } } });
    }

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return { requestedProfileIds };
}

test('switches profiles, filters the event list and persists across reload', async ({ page }) => {
  const { requestedProfileIds } = await setup(page);

  await page.goto('/dashboard');

  // Default "全部档案": both events visible.
  await expect(page.getByText('妈妈生日', { exact: true })).toBeVisible();
  await expect(page.getByText('小明疫苗', { exact: true })).toBeVisible();

  // Switch to 小明 (id 12).
  await page.getByLabel('切换档案').selectOption('12');
  await expect(page.getByText('小明疫苗', { exact: true })).toBeVisible();
  await expect(page.getByText('妈妈生日', { exact: true })).toHaveCount(0);
  // The filtering was real: a profileId=12 request was issued.
  expect(requestedProfileIds).toContain('12');

  // Reload: the per-device selection survives and the list stays filtered.
  await page.reload();
  await expect(page.getByLabel('切换档案')).toHaveValue('12');
  await expect(page.getByText('小明疫苗', { exact: true })).toBeVisible();
  await expect(page.getByText('妈妈生日', { exact: true })).toHaveCount(0);
});

test('switching to a profile with zero data shows an empty state and the switcher still works', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard');

  await page.getByLabel('切换档案').selectOption('13'); // 花花: no events
  await expect(page.getByText('暂无倒计时事件')).toBeVisible();
  await expect(page.getByLabel('切换档案')).toHaveValue('13');

  // Still usable: back to "全部档案" restores the full list.
  await page.getByLabel('切换档案').selectOption('');
  await expect(page.getByText('妈妈生日', { exact: true })).toBeVisible();
  await expect(page.getByText('小明疫苗', { exact: true })).toBeVisible();
});
