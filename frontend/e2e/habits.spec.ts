import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { computeHabitStreak, shiftCalendarDays } from '@timemark/shared/habit-schedule';

/**
 * 习惯打卡页（plan todo 66）端到端。
 *
 * 时间切片：`streak.today` 由后端给出，页面的 ISO 周窗口由它推导，因此测试无需
 * 依赖真实挂钟即可稳定落在「有未来日期的一周」：固定 today=2026-03-10（周二），
 * 本周为 2026-03-09（周一）.. 2026-03-15（周日），未来日期必然存在。
 *
 * - happy: 新建 → tap-to-log → 连胜=1 → 网格今日格填充 → 二次打卡不新增第二格。
 * - failure: 未来日期格 disabled，点击不发送请求。
 * - 有牙齿的负向对照：未填充格的「填充断言」必须抛错；把连胜写死为 1 必须被断言抓住。
 * - 畸形：空 schedule_days / null reminder_times / 400 天历史（窗口化）/ 网格 500。
 * - prompt injection：习惯名中的 HTML/script 作为纯文本渲染。
 * - axe：390x844 与 1440x900 零 critical 违规。
 * - visual：浅/深色截图，且 prefers-reduced-motion 生效（transition-duration = 0）。
 *
 * dev build 跨域请求 http://localhost:3000/api，mock 必须带 CORS 头。
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const USER = { id: 1, username: 'e2e-habits-user', role: 'admin', mustChangePassword: false };
const TODAY = '2026-03-10';
const WEEK_FROM = '2026-03-09';
const WEEK_TO = '2026-03-15';
const NOW = new Date('2026-03-10T12:00:00+08:00');

interface HabitRow {
  id: number;
  user_id: number;
  profile_id: number | null;
  name: string;
  icon: string | null;
  target_per_period: number;
  period: 'day' | 'week';
  schedule_days: number[] | null;
  reminder_times: string[] | null;
  color: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface HabitLogRow {
  id: number;
  habit_id: number;
  user_id: number;
  logged_on: string;
  count: number;
  note: string | null;
  created_at: string;
}

interface MockState {
  habits: HabitRow[];
  logs: HabitLogRow[];
  logCalls: number;
  requests: string[];
}

interface SetupOptions {
  habits?: Array<Partial<HabitRow> & { id: number; name: string }>;
  logs?: HabitLogRow[];
  theme?: 'light' | 'dark';
  gridError?: boolean;
}

function habit(partial: Partial<HabitRow> & { id: number; name: string }): HabitRow {
  const now = new Date().toISOString();
  return {
    user_id: 1,
    profile_id: null,
    icon: null,
    target_per_period: 1,
    period: 'day',
    schedule_days: null,
    reminder_times: null,
    color: null,
    is_active: true,
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function logRow(id: number, habitId: number, loggedOn: string, count: number): HabitLogRow {
  return {
    id,
    habit_id: habitId,
    user_id: 1,
    logged_on: loggedOn,
    count,
    note: null,
    created_at: new Date().toISOString(),
  };
}

/** 与 backend habit.service.ts 的 streakFor 同源：直接用 shared 的纯函数。 */
function streakFor(state: MockState, target: HabitRow) {
  const result = computeHabitStreak({
    period: target.period,
    targetPerPeriod: target.target_per_period,
    logs: state.logs
      .filter((log) => log.habit_id === target.id)
      .map((log) => ({ loggedOn: log.logged_on, count: log.count })),
    now: NOW,
    timeZone: 'Asia/Shanghai',
    scheduleDays: target.schedule_days,
  });
  return {
    current: result.currentStreak,
    longest: result.longestStreak,
    todayCount: result.todayCount,
    targetMet: result.targetMet,
    today: result.todayYmd,
    periodKey: result.currentPeriodKey,
  };
}

function withStreak(state: MockState, target: HabitRow) {
  return { ...target, streak: streakFor(state, target) };
}

async function setup(page: Page, options: SetupOptions = {}): Promise<MockState> {
  const state: MockState = {
    habits: (options.habits ?? []).map(habit),
    logs: options.logs ? options.logs.map((log) => ({ ...log })) : [],
    logCalls: 0,
    requests: [],
  };
  let nextHabitId = state.habits.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  let nextLogId = state.logs.reduce((max, row) => Math.max(max, row.id), 0) + 1;

  await page.addInitScript(
    ({ token, themeName }) => {
      localStorage.setItem('accessToken', token);
      if (themeName) localStorage.setItem('theme', themeName);
    },
    { token: 'e2e-habits-token', themeName: options.theme ?? '' },
  );

  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': 'http://localhost:5173',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function grid(from: string, to: string) {
    const days: string[] = [];
    let cursor: string | null = from;
    let guard = 0;
    while (cursor && cursor <= to && guard < 400) {
      days.push(cursor);
      cursor = shiftCalendarDays(cursor, 1);
      guard += 1;
    }
    return {
      from,
      to,
      habits: state.habits
        .filter((row) => row.is_active)
        .map((row) => ({
          id: row.id,
          name: row.name,
          icon: row.icon,
          color: row.color,
          targetPerPeriod: row.target_per_period,
          period: row.period,
          days: days.map((date) => {
            const count = state.logs
              .filter((log) => log.habit_id === row.id && log.logged_on === date)
              .reduce((sum, log) => sum + log.count, 0);
            return { date, count, met: count >= row.target_per_period };
          }),
        })),
    };
  }

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const pathname = url.pathname;
    state.requests.push(`${method} ${pathname}`);

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') {
      return json(route, { success: true, data: { siteKey: null, enabled: false } });
    }

    if (pathname === '/api/habits/grid' && method === 'GET') {
      if (options.gridError) return json(route, { success: false, error: 'internal error' }, 500);
      const from = url.searchParams.get('from') ?? WEEK_FROM;
      const to = url.searchParams.get('to') ?? WEEK_TO;
      return json(route, { success: true, data: grid(from, to) });
    }

    const logMatch = /^\/api\/habits\/(\d+)\/log$/.exec(pathname);
    if (logMatch && method === 'POST') {
      state.logCalls += 1;
      const habitId = Number(logMatch[1]);
      const target = state.habits.find((row) => row.id === habitId);
      if (!target) return json(route, { success: false, error: '习惯不存在' }, 404);
      const body = (req.postDataJSON() ?? {}) as { loggedOn?: string; count?: number; note?: string | null };
      const loggedOn = body.loggedOn ?? TODAY;
      if (loggedOn > TODAY) {
        return json(route, { success: false, error: `不能为未来日期打卡（今天是 ${TODAY}）` }, 400);
      }
      const existing = state.logs.find((log) => log.habit_id === habitId && log.logged_on === loggedOn);
      const delta = body.count ?? 1;
      if (existing) {
        existing.count += delta;
        if (body.note != null) existing.note = body.note;
        return json(route, { success: true, data: existing });
      }
      const row = logRow(nextLogId++, habitId, loggedOn, delta);
      state.logs.push(row);
      return json(route, { success: true, data: row });
    }

    const idMatch = /^\/api\/habits\/(\d+)$/.exec(pathname);
    if (idMatch && method === 'PATCH') {
      const target = state.habits.find((row) => row.id === Number(idMatch[1]));
      if (!target) return json(route, { success: false, error: '习惯不存在' }, 404);
      const body = (req.postDataJSON() ?? {}) as Partial<Record<string, unknown>>;
      if (typeof body.name === 'string') target.name = body.name;
      if (body.icon === null || typeof body.icon === 'string') target.icon = body.icon as string | null;
      if (typeof body.targetPerPeriod === 'number') target.target_per_period = body.targetPerPeriod;
      if (body.period === 'day' || body.period === 'week') target.period = body.period;
      if (body.scheduleDays === null || Array.isArray(body.scheduleDays)) {
        target.schedule_days = body.scheduleDays as number[] | null;
      }
      if (typeof body.isActive === 'boolean') target.is_active = body.isActive;
      target.updated_at = new Date().toISOString();
      return json(route, { success: true, data: withStreak(state, target) });
    }
    if (idMatch && method === 'DELETE') {
      state.habits = state.habits.filter((row) => row.id !== Number(idMatch[1]));
      return json(route, { success: true });
    }

    if (pathname === '/api/habits' && method === 'GET') {
      return json(route, { success: true, data: state.habits.map((row) => withStreak(state, row)) });
    }
    if (pathname === '/api/habits' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Partial<Record<string, unknown>>;
      const created = habit({
        id: nextHabitId++,
        name: String(body.name ?? ''),
        icon: typeof body.icon === 'string' ? body.icon : null,
        target_per_period: typeof body.targetPerPeriod === 'number' ? body.targetPerPeriod : 1,
        period: body.period === 'week' ? 'week' : 'day',
        schedule_days: Array.isArray(body.scheduleDays) ? (body.scheduleDays as number[]) : null,
        reminder_times: Array.isArray(body.reminderTimes) ? (body.reminderTimes as string[]) : null,
        is_active: body.isActive !== false,
      });
      state.habits.push(created);
      return json(route, { success: true, data: withStreak(state, created) }, 201);
    }

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return state;
}

async function probePrimary(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'hsl(var(--primary))';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

/** 与 happy path 相同的「网格已填充」断言，复用以便负向对照重放。 */
async function expectCellFilled(page: Page, cell: Locator): Promise<void> {
  await expect(cell).toHaveAttribute('data-filled', 'true');
  await expect(cell).toHaveAttribute('data-met', 'true');
  const primary = await probePrimary(page);
  const background = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).toBe(primary);
}

/** 与 happy path 相同的「连胜徽章」断言，复用以便负向对照重放。 */
async function expectCurrentStreak(page: Page, habitId: number, value: number): Promise<void> {
  await expect(page.getByTestId(`habit-streak-current-${habitId}`)).toHaveAttribute('data-streak', String(value));
}

function writeEvidence(fileName: string, payload: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, `${fileName}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

test('habits happy path: create -> tap-to-log -> streak 1 -> grid cell filled -> double log adds no second cell', async ({ page }) => {
  test.setTimeout(90_000);
  const state = await setup(page);

  await page.goto('/habits');
  await expect(page.getByRole('heading', { name: '习惯打卡' })).toBeVisible();
  await expect(page.getByTestId('habit-empty')).toBeVisible();

  await page.getByLabel('新建习惯').click();
  await page.getByLabel('习惯名称').fill('晨跑');
  await page.getByLabel('保存习惯').click();

  await expect(page.getByTestId('habit-row-1')).toBeVisible();
  await expectCurrentStreak(page, 1, 0);

  const cells = page.locator('[data-testid^="habit-cell-1-"]');
  await expect(cells).toHaveCount(7);

  const todayCell = page.getByTestId(`habit-cell-1-${TODAY}`);
  await expect(todayCell).toBeVisible();
  await expect(todayCell).toHaveAttribute('data-count', '0');
  await expect(todayCell).toHaveAttribute('data-filled', 'false');

  await page.getByTestId('habit-log-1').click();

  await expectCurrentStreak(page, 1, 1);
  await expect(page.getByTestId('habit-today-badge-1')).toHaveAttribute('data-met', 'true');
  await expect(todayCell).toHaveAttribute('data-count', '1');
  await expectCellFilled(page, todayCell);
  await expect(page.getByRole('status').filter({ hasText: '已打卡' })).toBeVisible();

  // 同日重复打卡：count 累加为 2，网格仍是 7 格（绝不出现第二个同日格）。
  await page.getByTestId('habit-log-1').click();
  await expect(todayCell).toHaveAttribute('data-count', '2');
  await expect(page.locator('[data-testid^="habit-cell-1-"]')).toHaveCount(7);
  await expectCurrentStreak(page, 1, 1);

  expect(state.logs).toHaveLength(1);
  expect(state.logs[0].count).toBe(2);
  writeEvidence('task-66-happy-state', {
    logs: state.logs,
    cellCounts: { today: 2 },
    requests: state.requests,
  });
});

test('habits failure path: a future date cell is not clickable and never sends a log request', async ({ page }) => {
  const state = await setup(page, { habits: [{ id: 2, name: '阅读' }] });

  await page.goto('/habits');
  await expect(page.getByRole('heading', { name: '习惯打卡' })).toBeVisible();
  await expect(page.getByTestId('habit-row-2')).toBeVisible();

  const tomorrow = page.getByTestId('habit-cell-2-2026-03-11');
  await expect(tomorrow).toHaveAttribute('data-future', 'true');
  await expect(tomorrow).toBeDisabled();

  // 过去 / 今天可打卡，明天不可。
  await expect(page.getByTestId('habit-cell-2-2026-03-09')).toBeEnabled();
  await expect(page.getByTestId(`habit-cell-2-${TODAY}`)).toBeEnabled();

  // A real Playwright click on the disabled cell must time out (proves it is not clickable).
  let clickFailed = false;
  try {
    await tomorrow.click({ timeout: 1_500 });
  } catch {
    clickFailed = true;
  }
  expect(clickFailed).toBe(true);

  // Even a scripted .click() on the disabled button does nothing.
  const before = state.logCalls;
  await tomorrow.evaluate((el) => {
    (el as HTMLButtonElement).click();
  });
  await page.waitForTimeout(200);
  expect(state.logCalls).toBe(before);
  expect(state.logs).toHaveLength(0);

  writeEvidence('task-66-future-cell', {
    futureCellDisabled: await tomorrow.isDisabled(),
    logCallsAfterAttempts: state.logCalls,
  });
});

test('adversarial: the fill and streak assertions have teeth (unfilled cell / hardcoded streak fails them)', async ({ page }) => {
  // 03-08 与 03-09 连续达标，今天(03-10)未打卡 → currentStreak = 2。
  await setup(page, {
    habits: [{ id: 3, name: '喝水' }],
    logs: [logRow(1, 3, '2026-03-08', 1), logRow(2, 3, '2026-03-09', 1)],
  });

  await page.goto('/habits');
  await expect(page.getByRole('heading', { name: '习惯打卡' })).toBeVisible();

  // 真实连胜 = 2；写死为 1 会被下面这条断言抓住。
  await expectCurrentStreak(page, 3, 2);

  let streakThrew = false;
  try {
    await expectCurrentStreak(page, 3, 1);
  } catch {
    streakThrew = true;
  }
  expect(streakThrew).toBe(true);

  // 今天的格子未填充 → happy path 的填充断言必须抛错（不是空断言）。
  const todayCell = page.getByTestId(`habit-cell-3-${TODAY}`);
  await expect(todayCell).toHaveAttribute('data-filled', 'false');
  const primary = await probePrimary(page);
  const background = await todayCell.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).not.toBe(primary);

  let fillThrew = false;
  try {
    await expectCellFilled(page, todayCell);
  } catch {
    fillThrew = true;
  }
  expect(fillThrew).toBe(true);

  writeEvidence('task-66-negative-controls', {
    actualStreak: 2,
    hardcodedStreakThrew: streakThrew,
    unfilledCellThrew: fillThrew,
  });
});

test('adversarial malformed: empty schedule_days, null reminder_times and a 400-day history stay windowed and numeric', async ({ page }) => {
  const history: HabitLogRow[] = [];
  for (let i = 0; i < 400; i += 1) {
    const date = shiftCalendarDays(TODAY, -i);
    if (date) history.push(logRow(i + 1, 4, date, 1));
  }
  await setup(page, {
    habits: [{ id: 4, name: '冥想', schedule_days: [], reminder_times: null, target_per_period: 1 }],
    logs: history,
  });

  await page.goto('/habits');
  await expect(page.getByRole('heading', { name: '习惯打卡' })).toBeVisible();
  await expect(page.getByTestId('habit-row-4')).toBeVisible();

  // 网格只渲染请求窗口的 7 天（不是 400 天）。
  const cells = page.locator('[data-testid^="habit-cell-4-"]');
  await expect(cells).toHaveCount(7);

  // 每个 count 都是数字（无 NaN），连胜也是数字。
  const counts = await cells.evaluateAll((els) => els.map((el) => el.getAttribute('data-count')));
  expect(counts.every((value) => value !== null && /^\d+$/.test(value))).toBe(true);
  const streakAttr = await page.getByTestId('habit-streak-current-4').getAttribute('data-streak');
  expect(streakAttr !== null && /^\d+$/.test(streakAttr)).toBe(true);

  await expect(page.locator('h1', { hasText: '习惯打卡' })).toBeVisible();
  writeEvidence('task-66-malformed-history', { renderedCells: counts.length, streak: streakAttr, historyRows: history.length });
});

test('adversarial malformed: a 500 from the grid API shows an error and keeps the habit list alive', async ({ page }) => {
  await setup(page, { gridError: true, habits: [{ id: 5, name: '拉伸' }] });

  await page.goto('/habits');
  await expect(page.getByRole('heading', { name: '习惯打卡' })).toBeVisible();

  // The list survives; the grid failure surfaces as an alert, no crash.
  await expect(page.getByTestId('habit-row-5')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('internal error');
  await expect(page.locator('[data-testid^="habit-cell-5-"]')).toHaveCount(0);
  await expect(page.locator('h1', { hasText: '习惯打卡' })).toBeVisible();
});

test('adversarial prompt injection: a hostile habit name renders as inert text', async ({ page }) => {
  const hostile = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
  await setup(page, { habits: [{ id: 6, name: hostile }] });

  await page.goto('/habits');
  await expect(page.getByRole('heading', { name: '习惯打卡' })).toBeVisible();

  const main = page.locator('#main-content');
  await expect(main).toContainText('<img');
  await expect(main.locator('img')).toHaveCount(0);
  await expect(main.locator('script')).toHaveCount(0);
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss).toBeUndefined();
});

for (const viewport of [
  { id: '390x844', width: 390, height: 844 },
  { id: '1440x900', width: 1440, height: 900 },
] as const) {
  test(`a11y habits: zero critical Axe violations at ${viewport.id}`, async ({ page }) => {
    test.setTimeout(90_000);
    await setup(page, {
      habits: [
        { id: 7, name: '晨跑', icon: '🏃' },
        { id: 8, name: '阅读', target_per_period: 2 },
      ],
      logs: [logRow(1, 7, TODAY, 1), logRow(2, 8, '2026-03-09', 2)],
    });

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/habits');
    await expect(page.getByRole('heading', { name: '习惯打卡' })).toBeVisible();
    await expect(page.getByTestId('habit-row-7')).toBeVisible();
    await page.waitForTimeout(600);

    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((v) => v.impact === 'critical');
    writeEvidence(`task-66-axe-habits-${viewport.id}`, {
      viewport: viewport.id,
      violationCounts: {
        total: results.violations.length,
        critical: critical.length,
        serious: results.violations.filter((v) => v.impact === 'serious').length,
        moderate: results.violations.filter((v) => v.impact === 'moderate').length,
        minor: results.violations.filter((v) => v.impact === 'minor').length,
      },
      violations: results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => ({ target: n.target, html: n.html })),
      })),
    });
    expect(critical, `critical violations: ${JSON.stringify(critical.map((v) => v.id))}`).toEqual([]);
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`habits visual snapshot (${theme}) with prefers-reduced-motion`, async ({ page }) => {
    test.setTimeout(90_000);
    await setup(page, {
      theme,
      habits: [
        { id: 9, name: '晨跑', icon: '🏃' },
        { id: 10, name: '阅读', icon: '📚', target_per_period: 2 },
      ],
      logs: [
        logRow(1, 9, TODAY, 1),
        logRow(2, 9, '2026-03-09', 1),
        logRow(3, 10, TODAY, 2),
        logRow(4, 10, '2026-03-09', 1),
      ],
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/habits');
    await expect(page.getByRole('heading', { name: '习惯打卡' })).toBeVisible();
    await expect(page.getByTestId('habit-row-9')).toBeVisible();
    await page.waitForTimeout(400);

    // prefers-reduced-motion respected: interactive transitions collapse to 0s.
    const duration = await page
      .getByTestId('habit-log-9')
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(duration)).toBeLessThan(0.05);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-66-habits-${theme}.png`), fullPage: true });
  });
}
