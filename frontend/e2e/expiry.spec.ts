import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * 到期中心（D1，todo 47）端到端：
 * - happy: 登录 → 新建到期项 → 出现倒计时 → 续期 → 日期真实前进（断言到具体日期）
 * - failure: 过去 next_due_date 必须落在 overdue 桶，并使用 destructive 设计令牌（绝不隐藏）
 * - visual: 深浅色主题各截一张图，供视觉走查
 *
 * 前端 dev build 跨域请求 `http://localhost:3000/api`，因此 mock 必须带 CORS 头。
 * 后端已实现（todo 45/46），此处用有状态 mock 复现其行为并记录续期调用次数。
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const USER = { id: 1, username: 'e2e-expiry-user', role: 'admin', mustChangePassword: false };

interface ExpiryRow {
  id: number;
  user_id: number;
  profile_id: number | null;
  kind: string;
  title: string;
  vendor: string | null;
  amount_cents: number | null;
  currency: string;
  cycle: string;
  cycle_days: number | null;
  start_date: string | null;
  next_due_date: string;
  auto_renew: boolean;
  notes: string | null;
  tags: string[];
  reminder_config: null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

/** Mirror of shared `advanceExpiryDate` for the mock (monthly clamps to month end). */
function advance(dateYmd: string, cycle: string, cycleDays: number | null): string | null {
  const [y, m, d] = dateYmd.split('-').map(Number);
  if (cycle === 'monthly' || cycle === 'quarterly' || cycle === 'yearly') {
    const months = cycle === 'monthly' ? 1 : cycle === 'quarterly' ? 3 : 12;
    const total = y * 12 + (m - 1) + months;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    const last = new Date(ny, nm, 0).getDate();
    return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  }
  if (cycle === 'custom' && cycleDays && cycleDays > 0) {
    const base = new Date(y, m - 1, d);
    base.setDate(base.getDate() + cycleDays);
    return ymd(base);
  }
  return null;
}

function rowFromBody(id: number, body: Record<string, unknown>): ExpiryRow {
  const nowIso = new Date().toISOString();
  return {
    id,
    user_id: 1,
    profile_id: null,
    kind: String(body.kind ?? 'custom'),
    title: String(body.title ?? ''),
    vendor: typeof body.vendor === 'string' ? body.vendor : null,
    amount_cents: typeof body.amountCents === 'number' ? body.amountCents : null,
    currency: String(body.currency ?? 'CNY'),
    cycle: String(body.cycle ?? 'once'),
    cycle_days: typeof body.cycleDays === 'number' ? body.cycleDays : null,
    start_date: typeof body.startDate === 'string' ? body.startDate : null,
    next_due_date: String(body.nextDueDate ?? ''),
    auto_renew: Boolean(body.autoRenew),
    notes: typeof body.notes === 'string' ? body.notes : null,
    tags: [],
    reminder_config: null,
    is_active: body.isActive !== false,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

interface MockState {
  rows: ExpiryRow[];
  renewCalls: number;
}

async function setup(page: Page, seed: ExpiryRow[], theme?: 'light' | 'dark'): Promise<MockState> {
  const state: MockState = { rows: seed.map((row) => ({ ...row })), renewCalls: 0 };
  let nextId = seed.reduce((max, row) => Math.max(max, row.id), 0) + 1;

  await page.addInitScript(
    ({ token, themeName }) => {
      localStorage.setItem('accessToken', token);
      if (themeName) localStorage.setItem('theme', themeName);
    },
    { token: 'e2e-expiry-token', themeName: theme ?? '' },
  );

  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': 'http://localhost:5173',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };

  const emptyCosts = {
    totalCents: 0,
    currency: null,
    mixedCurrencies: false,
    byCurrency: {},
    byKind: [],
    monthly: [],
    once: { totalCents: 0, currency: null, byCurrency: {}, count: 0 },
  };

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const pathname = url.pathname;
    const today = ymd(new Date());

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') {
      return json(route, { success: true, data: { siteKey: null, enabled: false } });
    }
    if (pathname === '/api/expiry/overdue') {
      return json(route, {
        success: true,
        data: state.rows.filter((row) => row.is_active && row.next_due_date < today),
      });
    }
    if (pathname === '/api/expiry/upcoming') return json(route, { success: true, data: [], days: 30 });
    if (pathname === '/api/expiry/costs') return json(route, { success: true, data: emptyCosts });

    const renewMatch = /^\/api\/expiry\/(\d+)\/renew$/.exec(pathname);
    if (renewMatch && req.method() === 'POST') {
      state.renewCalls += 1;
      const id = Number(renewMatch[1]);
      const row = state.rows.find((candidate) => candidate.id === id);
      if (!row) return json(route, { success: false, error: '到期项不存在' }, 404);
      const fromDate = row.next_due_date;
      const next = advance(row.next_due_date, row.cycle, row.cycle_days);
      if (!next) return json(route, { success: false, error: '一次性到期项不能续期' }, 400);
      row.next_due_date = next;
      row.updated_at = new Date().toISOString();
      return json(route, {
        success: true,
        data: {
          item: row,
          history: { id: 1, item_id: id, action: 'renew', from_date: fromDate, to_date: next, amount_cents: row.amount_cents, created_at: row.updated_at },
        },
      });
    }

    if (pathname === '/api/expiry' && req.method() === 'GET') {
      const kind = url.searchParams.get('kind');
      const active = url.searchParams.get('active');
      const q = url.searchParams.get('q');
      let list = state.rows.slice();
      if (kind) list = list.filter((row) => row.kind === kind);
      if (active === 'true') list = list.filter((row) => row.is_active);
      if (active === 'false') list = list.filter((row) => !row.is_active);
      if (q) {
        const needle = q.toLowerCase();
        list = list.filter((row) => `${row.title} ${row.vendor ?? ''}`.toLowerCase().includes(needle));
      }
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 200, total: list.length, totalPages: 1 } });
    }

    if (pathname === '/api/expiry' && req.method() === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const row = rowFromBody(nextId++, body);
      state.rows.push(row);
      return json(route, { success: true, data: row }, 201);
    }

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return state;
}

function item(overrides: Partial<ExpiryRow> & { id: number; title: string; next_due_date: string }): ExpiryRow {
  return {
    user_id: 1,
    profile_id: null,
    kind: 'subscription',
    vendor: null,
    amount_cents: 1999,
    currency: 'CNY',
    cycle: 'monthly',
    cycle_days: null,
    start_date: null,
    auto_renew: false,
    notes: null,
    tags: [],
    reminder_config: null,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test('expiry happy path: create -> live countdown -> renew advances the real date', async ({ page }) => {
  const state = await setup(page, []);
  const today = new Date();
  const dueDate = addDays(today, 30);
  const dueYmd = ymd(dueDate);
  const advancedYmd = advance(dueYmd, 'monthly', null)!;

  await page.goto('/expiry');
  await expect(page.getByRole('heading', { name: '到期中心' })).toBeVisible();

  await page.getByLabel('新建到期项').click();
  await page.getByLabel('名称', { exact: true }).fill('云盘会员');
  await page.getByLabel('类型', { exact: true }).selectOption('subscription');
  await page.getByLabel('续费周期', { exact: true }).selectOption('monthly');
  await page.getByLabel('下次到期日', { exact: true }).fill(dueYmd);
  await page.getByLabel('金额', { exact: true }).fill('19.99');
  await page.getByLabel('保存到期项').click();

  const row = page.getByTestId('expiry-item-1');
  await expect(row).toBeVisible();

  const countdown = page.getByTestId('expiry-countdown-1');
  await expect(countdown).toBeVisible();
  await expect(countdown).toContainText('还有');
  await expect(countdown).toContainText('天');

  await expect(page.getByTestId('expiry-due-1')).toHaveText(dueYmd);

  await page.getByLabel('续期 云盘会员').click();

  // A real date change: the rendered due date becomes exactly the advanced date.
  await expect(page.getByTestId('expiry-due-1')).toHaveText(advancedYmd);
  expect(advancedYmd).not.toBe(dueYmd);
  expect(state.renewCalls).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: '已续期至' })).toBeVisible();
});

test('expiry failure path: a past due date renders in the overdue bucket with the destructive token', async ({ page }) => {
  const pastYmd = ymd(addDays(new Date(), -10));
  await setup(page, [item({ id: 7, title: '过期会员', next_due_date: pastYmd })]);

  await page.goto('/expiry');
  await expect(page.getByRole('heading', { name: '到期中心' })).toBeVisible();

  const overdueBucket = page.getByTestId('expiry-bucket-overdue');
  await expect(overdueBucket).toBeVisible();

  const pastRow = overdueBucket.getByTestId('expiry-item-7');
  await expect(pastRow).toBeVisible();
  await expect(pastRow).toHaveAttribute('data-overdue', 'true');

  // Positional proof: the same item must NOT be in the "this week" bucket. If the
  // bucket logic mislabelled it, the assertion below flips and fails.
  await expect(page.locator('[data-testid="expiry-bucket-week"] [data-testid="expiry-item-7"]')).toHaveCount(0);

  const badge = page.getByTestId('expiry-overdue-badge-7');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-token', 'destructive');

  // Resolve the destructive design token and assert the badge actually uses it.
  const expectedColor = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'hsl(var(--destructive))';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  const badgeColor = await badge.evaluate((el) => getComputedStyle(el).color);
  expect(badgeColor).toBe(expectedColor);
  expect(badgeColor).not.toBe('rgb(0, 0, 0)');

  await expect(page.getByTestId('expiry-countdown-7')).toContainText('已逾期');
  await expect(page.getByTestId('expiry-summary-overdue')).toHaveAttribute('data-count', '1');
});

for (const theme of ['light', 'dark'] as const) {
  test(`expiry visual snapshot (${theme})`, async ({ page }) => {
    const soon = ymd(addDays(new Date(), 5));
    await setup(
      page,
      [
        item({ id: 21, title: '视频会员订阅', next_due_date: ymd(addDays(new Date(), -3)), kind: 'subscription' }),
        item({ id: 22, title: '车险续保', next_due_date: soon, kind: 'insurance', cycle: 'yearly', amount_cents: 480000 }),
        item({ id: 23, title: '域名 example.com', next_due_date: ymd(addDays(new Date(), 20)), kind: 'domain' }),
        item({ id: 24, title: '笔记本保修', next_due_date: ymd(addDays(new Date(), 90)), kind: 'warranty', cycle: 'once' }),
      ],
      theme,
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/expiry');
    await expect(page.getByRole('heading', { name: '到期中心' })).toBeVisible();
    await expect(page.getByTestId('expiry-bucket-overdue')).toBeVisible();
    await page.waitForTimeout(400);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-47-expiry-${theme}.png`), fullPage: true });
  });
}
