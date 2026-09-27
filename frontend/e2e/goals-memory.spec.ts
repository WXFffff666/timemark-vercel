import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * 目标页 + 时光回顾（plan todo 82）端到端。
 *
 * 覆盖：
 * - happy：创建目标 → 添加 3 个里程碑 → 完成 1 个 → 33% 进度。
 * - 时光回顾：种子一条 3 年前的同日事件，断言卡片列出它并带来源链接。
 * - QA failure：无历史的账号完全不渲染该卡片（不是空壳）。
 * - 负向对照（misleading_success_output）：2/3 时 33% 断言必须失败；空壳存在时
 *   「不渲染卡片」断言必须失败。
 * - stale_state：离开再返回后进度反映服务端最新值（不是陈旧缓存）。
 * - 畸形输入：0 里程碑（不是 NaN）、200 个里程碑、500 字标题。
 * - prompt injection：目标标题中的 HTML 作为纯文本渲染。
 * - 主题 / 无障碍：浅深两色截图 + Axe 零 critical。
 *
 * dev build 跨域请求 http://localhost:3000/api，mock 必须带 CORS 头。
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const USER = { id: 1, username: 'e2e-goals-user', role: 'admin', mustChangePassword: false };
const TODAY = '2026-09-28';

interface MilestoneRow {
  id: number;
  goal_id: number;
  title: string;
  due_at: string | null;
  done_at: string | null;
  sort_order: number;
  event_id: number | null;
}

interface GoalRow {
  id: number;
  user_id: number;
  profile_id: null;
  title: string;
  description: null;
  category: string | null;
  target_value: number | null;
  current_value: number;
  unit: string | null;
  start_date: string;
  target_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface MemoryItem {
  kind: 'event' | 'interaction';
  id: number;
  title: string;
  detail: string | null;
  occurredOn: string;
  yearsAgo: number;
  sourcePath: string;
  sourceLabel: string;
}

interface SeedGoal {
  id: number;
  title: string;
  category?: string | null;
  targetValue?: number | null;
  targetDate?: string | null;
  milestones?: Array<{ id: number; title: string; done?: boolean; dueAt?: string | null }>;
}

interface MockState {
  goals: GoalRow[];
  milestones: MilestoneRow[];
  memory: MemoryItem[];
  requests: string[];
}

interface SetupOptions {
  goals?: SeedGoal[];
  memory?: MemoryItem[];
  theme?: 'light' | 'dark';
}

function buildState(options: SetupOptions): MockState {
  const now = new Date().toISOString();
  const goals: GoalRow[] = [];
  const milestones: MilestoneRow[] = [];
  for (const seed of options.goals ?? []) {
    goals.push({
      id: seed.id,
      user_id: USER.id,
      profile_id: null,
      title: seed.title,
      description: null,
      category: seed.category ?? null,
      target_value: seed.targetValue ?? null,
      current_value: 0,
      unit: null,
      start_date: TODAY,
      target_date: seed.targetDate ?? null,
      status: 'active',
      created_at: now,
      updated_at: now,
    });
    (seed.milestones ?? []).forEach((milestone, index) => {
      milestones.push({
        id: milestone.id,
        goal_id: seed.id,
        title: milestone.title,
        due_at: milestone.dueAt ?? null,
        done_at: milestone.done ? now : null,
        sort_order: index,
        event_id: null,
      });
    });
  }
  return { goals, milestones, memory: options.memory ?? [], requests: [] };
}

function serializeGoal(state: MockState, goal: GoalRow) {
  const own = state.milestones.filter((m) => m.goal_id === goal.id);
  const doneCount = own.filter((m) => m.done_at != null).length;
  const progress =
    goal.target_value != null && goal.target_value > 0
      ? Math.min(100, Math.round((goal.current_value / goal.target_value) * 10000) / 100)
      : null;
  return {
    ...goal,
    progress,
    milestone_count: own.length,
    milestone_done_count: doneCount,
    milestones: own,
  };
}

async function setup(page: Page, options: SetupOptions = {}): Promise<MockState> {
  const state = buildState(options);
  let nextGoalId = state.goals.reduce((max, g) => Math.max(max, g.id), 0) + 1;
  let nextMilestoneId = state.milestones.reduce((max, m) => Math.max(max, m.id), 0) + 1;

  await page.addInitScript(
    ({ token, themeName }) => {
      localStorage.setItem('accessToken', token);
      if (themeName) localStorage.setItem('theme', themeName);
    },
    { token: 'e2e-goals-token', themeName: options.theme ?? '' },
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
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const pathname = new URL(req.url()).pathname;
    state.requests.push(`${method} ${pathname}`);

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') {
      return json(route, { success: true, data: { siteKey: null, enabled: false } });
    }

    // Dashboard dependencies (kept quiet so the page renders without noise).
    if (pathname === '/api/events') return json(route, { success: true, data: [] });
    if (pathname === '/api/stats/on-this-day') {
      return json(route, { success: true, data: { date: TODAY, items: state.memory } });
    }
    if (pathname === '/api/inbox') {
      return json(route, { success: true, data: [], pagination: { unreadCount: 0 } });
    }
    if (pathname === '/api/features/conflicts') return json(route, { success: true, data: [] });
    if (pathname === '/api/todos/completions') return json(route, { success: true, data: [] });
    if (pathname === '/api/profiles') return json(route, { success: true, data: [] });

    // --- goals ---
    if (pathname === '/api/goals' && method === 'GET') {
      return json(route, { success: true, data: state.goals.map((g) => serializeGoal(state, g)) });
    }
    if (pathname === '/api/goals' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const created: GoalRow = {
        id: nextGoalId++,
        user_id: USER.id,
        profile_id: null,
        title: String(body.title ?? ''),
        description: null,
        category: (body.category as string | null) ?? null,
        target_value: typeof body.targetValue === 'number' ? body.targetValue : null,
        current_value: 0,
        unit: (body.unit as string | null) ?? null,
        start_date: TODAY,
        target_date: (body.targetDate as string | null) ?? null,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.goals.push(created);
      return json(route, { success: true, data: serializeGoal(state, created) }, 201);
    }

    const milestoneAdd = /^\/api\/goals\/(\d+)\/milestones$/.exec(pathname);
    if (milestoneAdd && method === 'POST') {
      const goalId = Number(milestoneAdd[1]);
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const row: MilestoneRow = {
        id: nextMilestoneId++,
        goal_id: goalId,
        title: String(body.title ?? ''),
        due_at: (body.dueAt as string | null) ?? null,
        done_at: null,
        sort_order: state.milestones.filter((m) => m.goal_id === goalId).length,
        event_id: null,
      };
      state.milestones.push(row);
      return json(route, { success: true, data: row }, 201);
    }

    const milestoneToggle = /^\/api\/goals\/(\d+)\/milestones\/(\d+)\/toggle$/.exec(pathname);
    if (milestoneToggle && method === 'POST') {
      const milestoneId = Number(milestoneToggle[2]);
      const row = state.milestones.find((m) => m.id === milestoneId);
      if (!row) return json(route, { success: false, error: '里程碑不存在' }, 404);
      row.done_at = row.done_at ? null : new Date().toISOString();
      return json(route, { success: true, data: row });
    }

    const goalIdMatch = /^\/api\/goals\/(\d+)$/.exec(pathname);
    if (goalIdMatch && method === 'PATCH') {
      const goal = state.goals.find((g) => g.id === Number(goalIdMatch[1]));
      if (!goal) return json(route, { success: false, error: '目标不存在' }, 404);
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      if (typeof body.title === 'string') goal.title = body.title;
      if (typeof body.status === 'string') goal.status = body.status;
      if (typeof body.targetValue === 'number' || body.targetValue === null) {
        goal.target_value = body.targetValue as number | null;
      }
      return json(route, { success: true, data: serializeGoal(state, goal) });
    }
    if (goalIdMatch && method === 'DELETE') {
      const goalId = Number(goalIdMatch[1]);
      state.goals = state.goals.filter((g) => g.id !== goalId);
      state.milestones = state.milestones.filter((m) => m.goal_id !== goalId);
      return json(route, { success: true });
    }

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return state;
}

function writeEvidence(fileName: string, payload: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, `${fileName}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

async function createGoalWithMilestones(page: Page, titles: string[]): Promise<void> {
  await page.getByLabel('新建目标').click();
  await page.getByLabel('目标名称').fill('跑一次全程马拉松');
  await page.getByLabel('保存目标').click();
  await expect(page.getByTestId('goal-card-1')).toBeVisible();
  const rows = page.locator('[data-testid^="milestone-row-"]');
  for (const [index, title] of titles.entries()) {
    await page.getByTestId('milestone-input-1').fill(title);
    await page.getByTestId('milestone-add-1').click();
    // Serialize: wait for this milestone to land before typing the next one.
    await expect(rows).toHaveCount(index + 1);
  }
}

test('goals happy path: 3 milestones, complete ONE, progress is exactly 33%', async ({ page }) => {
  test.setTimeout(90_000);
  const state = await setup(page);

  await page.goto('/goals');
  await expect(page.getByRole('heading', { name: '目标' })).toBeVisible();
  await expect(page.getByTestId('goal-empty')).toBeVisible();

  await createGoalWithMilestones(page, ['报名', '训练 16 周', '冲线']);

  await expect(page.locator('[data-testid^="milestone-row-"]')).toHaveCount(3);
  await expect(page.getByTestId('goal-progress-1')).toHaveAttribute('data-percent', '0');
  await expect(page.getByTestId('goal-progress-1')).toHaveText('0%');

  await page.getByTestId('milestone-toggle-1').click();

  await expect(page.getByTestId('milestone-toggle-1')).toHaveAttribute('data-done', 'true');
  await expect(page.getByTestId('goal-progress-1')).toHaveAttribute('data-percent', '33');
  await expect(page.getByTestId('goal-progress-1')).toHaveText('33%');
  // 1 done of 3 = 33%, not 34 and not 100.
  await expect(page.getByTestId('goal-progress-1')).not.toHaveText('100%');

  writeEvidence('task-82-playwright-happy', {
    goal: state.goals[0],
    milestones: state.milestones,
    percent: await page.getByTestId('goal-progress-1').getAttribute('data-percent'),
    requests: state.requests,
  });
});

test('negative control: the 33% assertion has teeth (2 of 3 renders 67%, so 33% fails)', async ({ page }) => {
  await setup(page, {
    goals: [
      {
        id: 1,
        title: '读 12 本书',
        milestones: [
          { id: 1, title: 'Q1', done: true },
          { id: 2, title: 'Q2', done: true },
          { id: 3, title: 'Q3', done: false },
        ],
      },
    ],
  });

  await page.goto('/goals');
  await expect(page.getByTestId('goal-card-1')).toBeVisible();
  await expect(page.getByTestId('goal-progress-1')).toHaveAttribute('data-percent', '67');

  // The happy-path helper expectation must throw against a real 2/3 state.
  let threw = false;
  try {
    await expect(page.getByTestId('goal-progress-1')).toHaveAttribute('data-percent', '33');
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test('memory card lists a seeded event from 3 years ago with a link to its source', async ({ page }) => {
  await setup(page, {
    memory: [
      {
        kind: 'event',
        id: 42,
        title: '2023 年的今天：搬进新家',
        detail: 'other',
        occurredOn: '2023-09-28',
        yearsAgo: 3,
        sourcePath: '/calendar',
        sourceLabel: '在日历中查看',
      },
    ],
  });

  await page.goto('/dashboard');
  await expect(page.getByTestId('time-machine-card')).toBeVisible();
  const item = page.getByTestId('memory-item-event-42');
  await expect(item).toBeVisible();
  await expect(item).toContainText('3 年前的今天');
  await expect(item).toContainText('搬进新家');
  await expect(page.getByTestId('memory-link-event-42')).toHaveAttribute('href', '/calendar');

  // The nav tile wires /goals into the dashboard navigation.
  await page.getByTestId('nav-goals').click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByRole('heading', { name: '目标' })).toBeVisible();
});

test('no-history account renders NO memory card at all (empty shell would fail the assertion)', async ({ page }) => {
  await setup(page, { memory: [] });

  await page.goto('/dashboard');
  // The dashboard itself is healthy…
  await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
  // …but there is no card, no skeleton, no shell.
  await expect(page.getByTestId('time-machine-card')).toHaveCount(0);

  // Negative control: if a shell WERE rendered, the assertion above must fail.
  await page.evaluate(() => {
    const shell = document.createElement('section');
    shell.setAttribute('data-testid', 'time-machine-card');
    document.body.appendChild(shell);
  });
  let threw = false;
  try {
    await expect(page.getByTestId('time-machine-card')).toHaveCount(0);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  await page.evaluate(() => document.querySelector('[data-testid="time-machine-card"]')?.remove());
});

test('stale_state: navigating away and back reflects the server, not a stale cache', async ({ page }) => {
  const state = await setup(page, {
    goals: [
      {
        id: 1,
        title: '存钱旅行',
        milestones: [
          { id: 1, title: '开账户', done: true },
          { id: 2, title: '存 50%', done: false },
          { id: 3, title: '订机票', done: false },
        ],
      },
    ],
  });

  await page.goto('/dashboard');
  await page.getByTestId('nav-goals').click();
  await expect(page.getByTestId('goal-progress-1')).toHaveAttribute('data-percent', '33');

  // Another device completes a second milestone while we are on the page.
  state.milestones[1].done_at = new Date().toISOString();

  // Leave and come back via client-side routing; the list is re-fetched.
  await page.getByLabel('返回上一页').click();
  await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
  await page.getByTestId('nav-goals').click();
  await expect(page.getByTestId('goal-progress-1')).toHaveAttribute('data-percent', '67');
});

test('adversarial malformed: 0 milestones is 0% (not NaN), 200 milestones render, 500-char title stays text', async ({ page }) => {
  test.setTimeout(90_000);
  const longTitle = '回'.repeat(500);
  await setup(page, {
    goals: [
      { id: 1, title: '空目标' },
      {
        id: 2,
        title: '超长清单',
        milestones: Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, title: `里程碑 ${i + 1}` })),
      },
      { id: 3, title: longTitle },
    ],
  });

  await page.goto('/goals');
  await expect(page.getByTestId('goal-card-1')).toBeVisible();

  // 0 milestones -> 0%, numeric, never "NaN%".
  await expect(page.getByTestId('goal-progress-1')).toHaveAttribute('data-percent', '0');
  await expect(page.getByTestId('goal-progress-1')).toHaveText('0%');
  await expect(page.getByTestId('goal-progress-1')).not.toContainText('NaN');

  // 200 milestone rows render without truncating the list.
  await expect(page.locator('[data-testid^="milestone-row-"]')).toHaveCount(200);

  // The 500-char title is present as text and the card still renders.
  const title = page.getByTestId('goal-card-3').locator('h2');
  await expect(title).toHaveText(longTitle);
  expect((await title.textContent())?.length).toBe(500);

  writeEvidence('task-82-playwright-malformed', {
    zeroPercent: await page.getByTestId('goal-progress-1').getAttribute('data-percent'),
    milestoneRows: await page.locator('[data-testid^="milestone-row-"]').count(),
    longTitleLength: longTitle.length,
  });
});

test('adversarial prompt injection: a hostile goal title renders as inert text', async ({ page }) => {
  const hostile = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
  await setup(page, { goals: [{ id: 1, title: hostile }] });

  await page.goto('/goals');
  const main = page.locator('#main-content');
  await expect(main).toContainText('<img');
  await expect(main.locator('img')).toHaveCount(0);
  await expect(main.locator('script')).toHaveCount(0);
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss).toBeUndefined();
});

test('a11y goals: zero critical Axe violations at 1440x900', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, {
    goals: [
      {
        id: 1,
        title: '健身',
        category: '健康',
        targetDate: '2026-12-31',
        milestones: [
          { id: 1, title: '热身', done: true },
          { id: 2, title: '增肌' },
        ],
      },
    ],
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/goals');
  await expect(page.getByTestId('goal-card-1')).toBeVisible();
  await page.waitForTimeout(500);

  const results = await new AxeBuilder({ page }).analyze();
  const critical = results.violations.filter((v) => v.impact === 'critical');
  writeEvidence('task-82-axe-goals', {
    violationCounts: {
      total: results.violations.length,
      critical: critical.length,
    },
    violations: results.violations.map((v) => ({ id: v.id, impact: v.impact })),
  });
  expect(critical, `critical violations: ${JSON.stringify(critical.map((v) => v.id))}`).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`goals + memory visual snapshots (${theme})`, async ({ page }) => {
    test.setTimeout(90_000);
    await setup(page, {
      theme,
      goals: [
        {
          id: 1,
          title: '跑一次全程马拉松',
          category: '健身',
          targetDate: '2026-12-31',
          milestones: [
            { id: 1, title: '报名', done: true },
            { id: 2, title: '训练 16 周', dueAt: '2026-11-01' },
            { id: 3, title: '冲线', dueAt: '2026-12-31' },
          ],
        },
      ],
      memory: [
        {
          kind: 'event',
          id: 42,
          title: '2023 年的今天：搬进新家',
          detail: 'other',
          occurredOn: '2023-09-28',
          yearsAgo: 3,
          sourcePath: '/calendar',
          sourceLabel: '在日历中查看',
        },
        {
          kind: 'interaction',
          id: 7,
          title: '和老友吃饭',
          detail: '小张',
          occurredOn: '2021-09-28',
          yearsAgo: 5,
          sourcePath: '/contacts',
          sourceLabel: '查看联系记录',
        },
      ],
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.goto('/goals');
    await expect(page.getByTestId('goal-card-1')).toBeVisible();
    await page.waitForTimeout(400);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-82-goals-${theme}.png`), fullPage: true });

    await page.goto('/dashboard');
    await expect(page.getByTestId('time-machine-card')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-82-memory-${theme}.png`), fullPage: true });
  });
}
