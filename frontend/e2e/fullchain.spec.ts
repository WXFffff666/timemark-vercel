import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * 全链路真发真收（FULLCHAIN=1 才运行，常规 e2e 不受影响）。
 *
 * 前置（本地）：
 *   - Postgres 5433（容器 timemark-mig-test）+ 后端 8787：
 *       DATABASE_URL=postgres://postgres:migtest@localhost:5433/timemark \
 *       PORT=8787 CORS_ORIGIN=http://localhost:5189 CRON_SECRET=devcron \
 *       SMTP_REQUIRE_TLS=false \
 *       pnpm --filter backend dev
 *   - webhook 接收器：node scripts/dev-webhook-receiver.mjs 8790
 *   - （可选 SMTP 真收，FULLCHAIN_SMTP=1）node scripts/dev-smtp-sink.mjs 1025 1035
 *   - 前端 5189（同源代理）：MSYS_NO_PATHCONV=1 VITE_API_BASE=/api VITE_API_TARGET=http://localhost:8787 \
 *       npx vite --port 5189 --strictPort
 *   - 运行：FULLCHAIN=1 PLAYWRIGHT_CHANNEL=chrome PLAYWRIGHT_BASE_URL=http://localhost:5189 \
 *       npx playwright test e2e/fullchain.spec.ts
 *
 * 与既有 e2e 的区别：那套是 page.route 整站 mock 的 UI 测试；这里直连真后端，
 * 验证「登录 → 绑渠道 → 建事件 → 真发出 → 真收到 → 日志/收件箱/监控可见」。
 * Playwright 默认每个测试一个全新 context——登录态必须通过共享 context 传递。
 */

const API = '/api';
const RECEIVER = process.env.FULLCHAIN_RECEIVER ?? 'http://localhost:8790';
const SMTP = process.env.FULLCHAIN_SMTP === '1';
const SMTP_SINK = process.env.FULLCHAIN_SMTP_SINK ?? 'http://localhost:1035';
const USERNAME = process.env.FULLCHAIN_USER ?? 'admin';
const PASSWORD = process.env.FULLCHAIN_PASS ?? 'dev-only-not-a-credential';
const CRON_SECRET = process.env.FULLCHAIN_CRON_SECRET ?? 'devcron';

test.skip(!process.env.FULLCHAIN, 'FULLCHAIN=1 时才对真后端运行');

let context: BrowserContext;
let page: Page;

/** 以真实前端身份（cookie + 同源）调 API。 */
async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return page.evaluate(
    async ({ url, method, body }) => {
      const res = await fetch(url, {
        method: method ?? 'GET',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'include',
      });
      return (await res.json()) as T;
    },
    { url: `${API}${path}`, method: init?.method, body: init?.body },
  );
}

interface TriggerLogRow {
  id: number;
  event_id: number | null;
  channel_type: string;
  status: string;
  error_message?: string | null;
  channel_results?: Record<string, { success?: boolean; error?: string }> | string | null;
}

test.describe.serial('全链路真发真收', () => {
  let webhookAccountId: number | null = null;
  let smtpAccountId: number | null = null;
  let eventId: number | null = null;
  let eventName = '';

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto('/login');
    await page.getByPlaceholder('用户名').fill(USERNAME);
    await page.getByPlaceholder('密码').fill(PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL(/dashboard|settings\?changePassword=1/, { timeout: 20_000 });
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('清空接收器并绑定真实渠道（webhook → 本地接收器；SMTP → 本地 SMTP sink）', async () => {
    const reset = await page.request.delete(`${RECEIVER}/_received`);
    expect(reset.ok()).toBeTruthy();
    await page.request.delete(`${SMTP_SINK}/_mails`);

    const created = await api<{ success: boolean; data?: { id: number }; error?: string }>(
      '/config/accounts',
      {
        method: 'POST',
        body: {
          type: 'generic_webhook',
          name: '全链路-本地接收器',
          webhook: `${RECEIVER}/hook`,
          configMethod: 'webhook',
        },
      },
    );
    expect(created.success, created.error).toBeTruthy();
    webhookAccountId = created.data?.id ?? null;
    expect(webhookAccountId).toBeTruthy();

    if (SMTP) {
      // SMTP 字段复用约定：chatId=发件人邮箱、token=密码、webhook=服务器、secret=端口
      const smtp = await api<{ success: boolean; data?: { id: number }; error?: string }>(
        '/config/accounts',
        {
          method: 'POST',
          body: {
            type: 'smtp',
            name: '全链路-本地SMTP',
            chatId: 'sender@fullchain.local',
            token: 'no-auth-needed',
            webhook: 'localhost',
            secret: '1025',
            configMethod: 'webhook',
          },
        },
      );
      expect(smtp.success, smtp.error).toBeTruthy();
      smtpAccountId = smtp.data?.id ?? null;
    }
  });

  test('建事件（提醒时刻 +1 分钟）→ 发送链路真实触发', async () => {
    const triggerAt = new Date(Date.now() + 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const reminderTime = `${pad(triggerAt.getHours())}:${pad(triggerAt.getMinutes())}`;
    const date = `${triggerAt.getFullYear()}-${pad(triggerAt.getMonth() + 1)}-${pad(triggerAt.getDate())}`;
    eventName = `全链路真发测试 ${Date.now()}`;

    const accountIds = [webhookAccountId, smtpAccountId].filter((id): id is number => id !== null);
    const created = await api<{ success: boolean; data?: { id: number }; error?: string }>('/events', {
      method: 'POST',
      body: {
        name: eventName,
        type: 'other',
        date,
        calendarType: 'gregorian',
        reminderConfig: {
          enabled: true,
          daysBeforeList: [0],
          reminderTimes: [reminderTime],
          // SMTP 渠道的收件人兜底——本地 SMTP sink 接受任意 RCPT
          emailRecipients: SMTP ? ['receiver@fullchain.local'] : [],
          accountIds: accountIds.map(String),
        },
      },
    });
    expect(created.success, created.error).toBeTruthy();
    eventId = created.data?.id ?? null;
    expect(eventId).toBeTruthy();

    // 兜底触发：即使创建时的同步窗口没赶上，cron 入口也应把提醒发出去
    await page.request.get(`http://localhost:5189${API}/cron/reminder-check`, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
  });

  test('接收器真的收到了投递（webhook 真发真收）', async () => {
    test.setTimeout(120_000);
    expect(webhookAccountId).toBeTruthy();
    let items: Array<{ body: string; url: string }> = [];
    for (let i = 0; i < 30; i++) {
      const res = await page.request.get(`${RECEIVER}/_received`);
      const json = (await res.json()) as { count: number; items: Array<{ body: string; url: string }> };
      items = json.items;
      if (items.length > 0) break;
      await page.request.get(`http://localhost:5189${API}/cron/reminder-check`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      await page.waitForTimeout(3000);
    }
    expect(items.length, '本地 webhook 接收器应收到至少一次真实投递').toBeGreaterThan(0);
  });

  test('SMTP 真发 → 本地 SMTP 接收器真收', async () => {
    test.skip(!SMTP, '未启用 FULLCHAIN_SMTP');
    test.setTimeout(120_000);
    let count = 0;
    for (let i = 0; i < 30; i++) {
      const res = await page.request.get(`${SMTP_SINK}/_mails`);
      const json = (await res.json()) as { count: number };
      count = json.count;
      if (count > 0) break;
      await page.waitForTimeout(3000);
    }
    expect(count, '本地 SMTP 接收器应收到至少一封真实邮件').toBeGreaterThan(0);
  });

  test('触发日志记录了本次投递且 UI 可见', async () => {
    expect(eventId).toBeTruthy();
    let row: TriggerLogRow | null = null;
    for (let i = 0; i < 10 && !row; i++) {
      const res = await api<{ success: boolean; data: TriggerLogRow[] | { logs: TriggerLogRow[] } }>(
        `/trigger-logs?eventId=${eventId}&limit=50`,
      );
      const list = Array.isArray(res.data) ? res.data : (res.data?.logs ?? []);
      row = list[0] ?? null;
      if (!row) await page.waitForTimeout(2000);
    }
    expect(row, '本次事件的触发日志应存在').toBeTruthy();

    // channel_results 是按渠道的投递明细（channel_type 是聚合串，别按它断言）
    const results =
      typeof row!.channel_results === 'string'
        ? (JSON.parse(row!.channel_results!) as Record<string, { success?: boolean; error?: string }>)
        : row!.channel_results ?? {};
    expect(
      results.generic_webhook?.success,
      `generic_webhook 应投递成功（实际 ${JSON.stringify(results.generic_webhook)}）`,
    ).toBe(true);
    if (SMTP) {
      expect(results.smtp?.success, `smtp 应投递成功（实际 ${JSON.stringify(results.smtp)}）`).toBe(true);
    }

    await page.goto('/trigger-logs');
    await expect(page.getByText(eventName).first()).toBeVisible({ timeout: 15_000 });
  });

  test('收件箱：签名入站 + UI 可读', async () => {
    const info = await api<{
      success: boolean;
      data: { receiveUrl: string | null; receiveSecret?: string | null };
    }>('/inbox/info');
    expect(info.success).toBeTruthy();
    expect(info.data.receiveUrl, '收件地址应可用（按需生成）').toBeTruthy();

    const token = info.data.receiveUrl!.split('/receive/')[1]!;
    const rawBody = JSON.stringify({
      title: '全链路收件箱验证',
      body: '这条消息经由本地收信端点进入收件箱',
    });
    // 密钥存在时必须签名（v2.30 起密钥在 /inbox/info 对所有者下发）
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (info.data.receiveSecret) {
      const { createHmac } = await import('node:crypto');
      headers['X-Timemark-Signature'] = createHmac('sha256', info.data.receiveSecret)
        .update(rawBody)
        .digest('hex');
    }
    const send = await page.request.post(`http://localhost:5189${API}/inbox/receive/${token}`, {
      headers,
      data: rawBody,
    });
    expect(send.ok(), `收信端点应接受（${send.status()}）`).toBeTruthy();

    await page.goto('/inbox');
    const inboxRow = page.getByText('全链路收件箱验证').first();
    await expect(inboxRow).toBeVisible({ timeout: 15_000 });

    // v2.30：来源标签页——切到「外部推送」仍可见；「广播」为空但可切换不报错
    await page.getByRole('tab', { name: '外部推送' }).click();
    await expect(page.getByText('全链路收件箱验证').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: '广播' }).click();
    await page.getByRole('tab', { name: '全部' }).click();

    // v2.30：批量操作——勾选第一条 → 批量已读
    const firstCheckbox = page.getByLabel(/^选择消息：/).first();
    await firstCheckbox.check();
    await page.getByRole('button', { name: '批量已读' }).click();
    await expect(page.getByText('已选 1 条')).toBeHidden({ timeout: 10_000 });
  });

  test('Cron 监控：reminder-check 有运行记录且 UI 可见', async () => {
    await page.request.get(`http://localhost:5189${API}/cron/reminder-check`, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    await page.goto('/cron-monitor');
    await expect(page.getByText('reminder-check').first()).toBeVisible({ timeout: 15_000 });
  });
});
