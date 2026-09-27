import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * 库存 + 保养（D12，todo 51）端到端：
 * - happy(库存): 新建 → 消耗到阈值以下 → 低库存徽章点亮（invert 逻辑会让前置断言直接失败）
 * - failure(库存): 无 expires_at → 渲染「无保质期」而不是 NaN；消耗超过现有 → 400「库存不足」
 * - happy(保养): 新建 180 天计划 → 记录保养（更晚日期）→ next_due_at 真实前进
 * - visual: 两个页面在深浅色主题各截一张图
 *
 * 前端 dev build 跨域请求 `http://localhost:3000/api`，因此 mock 必须带 CORS 头。
 * 后端已实现（todo 49/50），此处用有状态 mock 复现其行为并记录调用。
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const USER = { id: 1, username: 'e2e-inventory-user', role: 'admin', mustChangePassword: false };

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(ymdText: string, days: number): string {
  const [y, m, d] = ymdText.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return ymd(date);
}

interface InvRow {
  id: number;
  user_id: number;
  profile_id: null;
  name: string;
  category: string;
  quantity: number;
  unit: string | null;
  low_stock_threshold: number | null;
  purchased_at: string | null;
  expires_at: string | null;
  location: string | null;
  notes: string | null;
  reminder_config: null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  id: number;
  user_id: number;
  profile_id: null;
  asset_name: string;
  asset_kind: string;
  interval_days: number | null;
  interval_usage: number | null;
  usage_unit: string | null;
  current_usage: number | null;
  last_done_at: string | null;
  next_due_at: string | null;
  next_due_usage: number | null;
  notes: string | null;
  reminder_config: null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function invRow(id: number, body: Record<string, unknown>): InvRow {
  const nowIso = new Date().toISOString();
  return {
    id,
    user_id: 1,
    profile_id: null,
    name: String(body.name ?? ''),
    category: String(body.category ?? 'other'),
    quantity: typeof body.quantity === 'number' ? body.quantity : 1,
    unit: body.unit == null ? null : String(body.unit),
    low_stock_threshold: typeof body.lowStockThreshold === 'number' ? body.lowStockThreshold : null,
    purchased_at: typeof body.purchasedAt === 'string' ? body.purchasedAt : null,
    expires_at: typeof body.expiresAt === 'string' ? body.expiresAt : null,
    location: typeof body.location === 'string' ? body.location : null,
    notes: body.notes == null ? null : String(body.notes),
    reminder_config: null,
    is_active: body.isActive !== false,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function planRow(id: number, body: Record<string, unknown>): PlanRow {
  const nowIso = new Date().toISOString();
  return {
    id,
    user_id: 1,
    profile_id: null,
    asset_name: String(body.assetName ?? ''),
    asset_kind: String(body.assetKind ?? 'other'),
    interval_days: typeof body.intervalDays === 'number' ? body.intervalDays : null,
    interval_usage: typeof body.intervalUsage === 'number' ? body.intervalUsage : null,
    usage_unit: body.usageUnit == null ? null : String(body.usageUnit),
    current_usage: typeof body.currentUsage === 'number' ? body.currentUsage : null,
    last_done_at: typeof body.lastDoneAt === 'string' ? body.lastDoneAt : null,
    next_due_at: typeof body.nextDueAt === 'string' ? body.nextDueAt : null,
    next_due_usage: typeof body.nextDueUsage === 'number' ? body.nextDueUsage : null,
    notes: body.notes == null ? null : String(body.notes),
    reminder_config: null,
    is_active: body.isActive !== false,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

interface MockState {
  inventory: InvRow[];
  plans: PlanRow[];
  consumeCalls: number;
  logCalls: number;
}

async function setup(
  page: Page,
  seed: { inventory?: InvRow[]; plans?: PlanRow[] } = {},
  theme?: 'light' | 'dark',
): Promise<MockState> {
  const state: MockState = {
    inventory: (seed.inventory ?? []).map((row) => ({ ...row })),
    plans: (seed.plans ?? []).map((row) => ({ ...row })),
    consumeCalls: 0,
    logCalls: 0,
  };
  let nextInvId = state.inventory.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  let nextPlanId = state.plans.reduce((max, row) => Math.max(max, row.id), 0) + 1;

  await page.addInitScript(
    ({ token, themeName }) => {
      localStorage.setItem('accessToken', token);
      if (themeName) localStorage.setItem('theme', themeName);
    },
    { token: 'e2e-inventory-token', themeName: theme ?? '' },
  );

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
    const today = ymd(new Date());

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') {
      return json(route, { success: true, data: { siteKey: null, enabled: false } });
    }

    // ---- Inventory ----
    if (pathname === '/api/inventory/low-stock') {
      const rows = state.inventory.filter(
        (row) => row.is_active && row.low_stock_threshold != null && row.quantity <= row.low_stock_threshold,
      );
      return json(route, { success: true, data: rows });
    }
    if (pathname === '/api/inventory/expiring') {
      const days = Number(url.searchParams.get('days') ?? '30') || 30;
      const limit = addDays(today, Number.isFinite(days) ? days : 30);
      const rows = state.inventory.filter(
        (row) => row.is_active && row.expires_at != null && row.expires_at <= limit,
      );
      return json(route, { success: true, data: rows, days });
    }
    const consumeMatch = /^\/api\/inventory\/(\d+)\/consume$/.exec(pathname);
    if (consumeMatch && req.method() === 'POST') {
      state.consumeCalls += 1;
      const id = Number(consumeMatch[1]);
      const row = state.inventory.find((candidate) => candidate.id === id);
      if (!row) return json(route, { success: false, error: '库存项不存在' }, 404);
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const amount = typeof body.quantity === 'number' ? body.quantity : 0;
      if (row.quantity < amount) {
        return json(
          route,
          { success: false, error: `库存不足：当前 ${row.quantity}${row.unit ?? ''}，无法消耗 ${amount}` },
          400,
        );
      }
      row.quantity -= amount;
      row.updated_at = new Date().toISOString();
      return json(route, { success: true, data: row });
    }
    if (pathname === '/api/inventory' && req.method() === 'GET') {
      const category = url.searchParams.get('category');
      const lowStock = url.searchParams.get('lowStock');
      const q = url.searchParams.get('q');
      let list = state.inventory.slice();
      if (category) list = list.filter((row) => row.category === category);
      if (lowStock === 'true') {
        list = list.filter(
          (row) => row.low_stock_threshold != null && row.quantity <= row.low_stock_threshold,
        );
      }
      if (q) {
        const needle = q.toLowerCase();
        list = list.filter((row) => `${row.name} ${row.location ?? ''}`.toLowerCase().includes(needle));
      }
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 200, total: list.length, totalPages: 1 } });
    }
    if (pathname === '/api/inventory' && req.method() === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const row = invRow(nextInvId++, body);
      state.inventory.push(row);
      return json(route, { success: true, data: row }, 201);
    }

    // ---- Maintenance ----
    const logMatch = /^\/api\/maintenance\/(\d+)\/log$/.exec(pathname);
    if (logMatch && req.method() === 'POST') {
      state.logCalls += 1;
      const id = Number(logMatch[1]);
      const plan = state.plans.find((candidate) => candidate.id === id);
      if (!plan) return json(route, { success: false, error: '保养计划不存在' }, 404);
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const doneAt = String(body.doneAt ?? today);
      const usageAt = typeof body.usageAt === 'number' ? body.usageAt : null;
      if (plan.interval_usage != null && usageAt == null) {
        return json(route, { success: false, error: '该计划按用量保养，记录时必须提供 usageAt（本次用量读数）' }, 400);
      }
      const effectiveDoneAt = plan.last_done_at && plan.last_done_at > doneAt ? plan.last_done_at : doneAt;
      const effectiveUsage =
        usageAt == null
          ? plan.current_usage
          : plan.current_usage == null
            ? usageAt
            : Math.max(plan.current_usage, usageAt);
      plan.last_done_at = effectiveDoneAt;
      plan.current_usage = effectiveUsage;
      plan.next_due_at = plan.interval_days != null ? addDays(effectiveDoneAt, plan.interval_days) : null;
      plan.next_due_usage =
        plan.interval_usage != null && effectiveUsage != null ? effectiveUsage + plan.interval_usage : null;
      plan.updated_at = new Date().toISOString();
      return json(
        route,
        {
          success: true,
          data: plan,
          log: { id: 1, plan_id: id, done_at: doneAt, usage_at: usageAt, cost_cents: null, notes: null, created_at: plan.updated_at },
        },
        201,
      );
    }
    if (pathname === '/api/maintenance' && req.method() === 'GET') {
      const assetKind = url.searchParams.get('assetKind');
      const active = url.searchParams.get('active');
      const q = url.searchParams.get('q');
      let list = state.plans.slice();
      if (assetKind) list = list.filter((row) => row.asset_kind === assetKind);
      if (active === 'true') list = list.filter((row) => row.is_active);
      if (active === 'false') list = list.filter((row) => !row.is_active);
      if (q) list = list.filter((row) => row.asset_name.toLowerCase().includes(q.toLowerCase()));
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 200, total: list.length, totalPages: 1 } });
    }
    if (pathname === '/api/maintenance' && req.method() === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const row = planRow(nextPlanId++, body);
      state.plans.push(row);
      return json(route, { success: true, data: row }, 201);
    }

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return state;
}

function seedInv(overrides: Partial<InvRow> & { id: number; name: string }): InvRow {
  return {
    user_id: 1,
    profile_id: null,
    category: 'food',
    quantity: 1,
    unit: '盒',
    low_stock_threshold: null,
    purchased_at: null,
    expires_at: null,
    location: null,
    notes: null,
    reminder_config: null,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test('inventory happy path: consume below the threshold lights the low-stock badge', async ({ page }) => {
  const state = await setup(page, { inventory: [] });
  const futureYmd = ymd(new Date(Date.now() + 10 * 86400000));

  await page.goto('/inventory');
  await expect(page.getByRole('heading', { name: '库存' })).toBeVisible();

  await page.getByLabel('新建库存项').click();
  await page.getByLabel('名称', { exact: true }).fill('牛奶');
  await page.getByLabel('分类', { exact: true }).selectOption('food');
  await page.getByLabel('数量', { exact: true }).fill('3');
  await page.getByLabel('低库存阈值', { exact: true }).fill('2');
  await page.getByLabel('单位', { exact: true }).fill('盒');
  await page.getByLabel('到期日', { exact: true }).fill(futureYmd);
  await page.getByLabel('保存库存项').click();

  const row = page.getByTestId('inventory-item-1');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('inventory-qty-1')).toHaveText('3 盒');
  await expect(page.getByTestId('inventory-expiry-1')).toContainText('还有');

  // Not yet low stock: 3 > 2. An inverted comparison would light the badge here and
  // make this assertion fail, so it pins the correct direction.
  await expect(page.getByTestId('inventory-low-stock-badge-1')).toHaveCount(0);

  await page.getByLabel('消耗 牛奶').click();

  await expect(page.getByTestId('inventory-qty-1')).toHaveText('2 盒');
  const badge = page.getByTestId('inventory-low-stock-badge-1');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-token', 'destructive');
  expect(state.consumeCalls).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: '已消耗' })).toBeVisible();
});

test('inventory failure path: no expiry renders 无保质期 and over-consume returns 库存不足', async ({ page }) => {
  await setup(page, {
    inventory: [
      seedInv({ id: 31, name: '大米', quantity: 5, unit: 'kg', expires_at: null }),
      seedInv({ id: 32, name: '纸巾', quantity: 0, unit: '包', low_stock_threshold: 0, expires_at: null }),
    ],
  });

  await page.goto('/inventory');
  await expect(page.getByRole('heading', { name: '库存' })).toBeVisible();

  const noExpiry = page.getByTestId('inventory-expiry-31');
  await expect(noExpiry).toHaveText('无保质期');
  await expect(noExpiry).toHaveAttribute('data-kind', 'none');
  await expect(noExpiry).not.toContainText('NaN');

  // Backend rejects consuming more than available: the page must surface the error,
  // keep the row, and never render NaN.
  await page.getByLabel('消耗 纸巾').click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('库存不足');
  await expect(page.getByTestId('inventory-qty-32')).toHaveText('0 包');
  await expect(page.getByTestId('inventory-expiry-32')).not.toContainText('NaN');
});

test('maintenance happy path: recording service advances the real next-due date', async ({ page }) => {
  const state = await setup(page, { plans: [] });
  const base = ymd(new Date());
  const originalDue = addDays(base, 180);
  const serviceDate = addDays(base, 30);
  const expectedDue = addDays(serviceDate, 180);

  await page.goto('/maintenance');
  await expect(page.getByRole('heading', { name: '保养' })).toBeVisible();

  await page.getByLabel('新建保养计划').click();
  await page.getByLabel('资产名称', { exact: true }).fill('家用轿车');
  await page.getByLabel('资产类型', { exact: true }).selectOption('vehicle');
  await page.getByLabel('按日期间隔（天）', { exact: true }).fill('180');
  await page.getByLabel('上次保养日期', { exact: true }).fill(base);
  await page.getByLabel('下次保养日期', { exact: true }).fill(originalDue);
  await page.getByLabel('保存保养计划').click();

  await expect(page.getByTestId('maintenance-card-1')).toBeVisible();
  await expect(page.getByTestId('maintenance-next-due-1')).toHaveText(originalDue);

  await page.getByLabel('记录保养 家用轿车').click();
  await expect(page.getByLabel('保养日期', { exact: true })).toBeVisible();
  await page.getByLabel('保养日期', { exact: true }).fill(serviceDate);
  await page.getByLabel('保存保养记录').click();

  // A REAL date change: next_due_at = service_date + 180d, not a local guess.
  await expect(page.getByTestId('maintenance-next-due-1')).toHaveText(expectedDue);
  expect(expectedDue).not.toBe(originalDue);
  expect(state.logCalls).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: '下次保养' })).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`inventory visual snapshot (${theme})`, async ({ page }) => {
    const today = new Date();
    await setup(
      page,
      {
        inventory: [
          seedInv({ id: 41, name: '牛奶', quantity: 2, unit: '盒', low_stock_threshold: 2, expires_at: ymd(new Date(today.getTime() + 3 * 86400000)) }),
          seedInv({ id: 42, name: '大米', quantity: 5, unit: 'kg', expires_at: null }),
          seedInv({ id: 43, name: '创可贴', category: 'medicine', quantity: 1, unit: '盒', low_stock_threshold: 3, expires_at: ymd(new Date(today.getTime() - 2 * 86400000)) }),
        ],
      },
      theme,
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/inventory');
    await expect(page.getByRole('heading', { name: '库存' })).toBeVisible();
    await expect(page.getByTestId('inventory-low-stock-badge-41')).toBeVisible();
    await page.waitForTimeout(400);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-51-inventory-${theme}.png`), fullPage: true });
  });

  test(`maintenance visual snapshot (${theme})`, async ({ page }) => {
    const base = ymd(new Date());
    await setup(
      page,
      {
        plans: [
          {
            ...planRow(51, {
              assetName: '家用轿车',
              assetKind: 'vehicle',
              intervalDays: 180,
              intervalUsage: 10000,
              usageUnit: 'km',
              currentUsage: 43000,
              lastDoneAt: addDays(base, -150),
              nextDueAt: addDays(base, 30),
              nextDueUsage: 50000,
            }),
          },
          {
            ...planRow(52, {
              assetName: '空气净化器',
              assetKind: 'appliance',
              intervalDays: 90,
              currentUsage: null,
              lastDoneAt: addDays(base, -100),
              nextDueAt: addDays(base, -10),
            }),
          },
        ],
      },
      theme,
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/maintenance');
    await expect(page.getByRole('heading', { name: '保养' })).toBeVisible();
    await expect(page.getByTestId('maintenance-card-51')).toBeVisible();
    await page.waitForTimeout(400);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-51-maintenance-${theme}.png`), fullPage: true });
  });
}
