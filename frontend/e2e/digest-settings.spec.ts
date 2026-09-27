import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * 摘要设置 + 预览（plan checkbox 80）端到端。
 *
 * 覆盖：
 * - happy：切换启用/周期/区块/收件人 → 「立即发送预览」在弹窗中渲染**真实数据**（种子
 *   事件「妈妈生日」）→ 保存 → reload 后设置仍在（从服务端重新拉取）。
 * - 负向对照（misleading_success_output）：把弹窗内容替换成占位符后，真实数据断言必须失败；
 *   未保存前 reload 必须回退到服务端旧值（证明“持久化”真的来自服务端，而不是本地 state）。
 * - 排除区块：取消勾选「未来 30 天」后预览中该区块视图消失。
 * - 空选择：全部取消 → 预览回退为全部区块，绝不为空。
 * - 无邮件渠道：预览仍渲染真实数据，并明确提示缺少邮件渠道；「立即发送」给出口径一致的说明。
 * - 畸形/注入：5 个覆盖收件人全部展示；恶意 HTML 作为纯文本渲染。
 * - 主题：浅/深两色截图（设置区块 + 预览弹窗）。
 *
 * dev build 跨域请求 http://localhost:3000/api，mock 必须带 CORS 头。
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const USER = { id: 1, username: 'e2e-digest-user', role: 'admin', mustChangePassword: false };
const ALL_SECTIONS = ['upcoming', 'overdue', 'spend', 'habits', 'medications', 'maintenance', 'goals'];

interface DigestState {
  enabled: boolean;
  period: 'monthly' | 'yearly';
  recipients: string[];
  sections: string[] | null;
  channelAccountId: number | null;
  defaultRecipients: string[];
  channelConfigured: boolean;
  accounts: Array<{ id: number; type: string; name: string; is_active: boolean }>;
  hostileUpcoming: boolean;
  requests: string[];
  lastPreviewBody: Record<string, unknown> | null;
  lastPreviewRecipients: string[] | null;
}

interface SetupOptions {
  theme?: 'light' | 'dark';
  state?: Partial<DigestState>;
}

function splitRecipients(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    if (/[\r\n<>]/.test(item)) continue;
    for (const part of item.split(/[,，;；\s]+/)) {
      const email = part.trim().toLowerCase();
      if (!email || email.length > 254) continue;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      if (!out.includes(email)) out.push(email);
    }
  }
  return out;
}

function buildPreview(state: DigestState, body: Record<string, unknown>) {
  const postedSections = Array.isArray(body.sections) ? body.sections.filter((s): s is string => typeof s === 'string') : null;
  const sections = postedSections && postedSections.length > 0 ? postedSections : ALL_SECTIONS;
  const has = (key: string) => sections.includes(key);

  const postedRecipients = body.recipients === undefined ? state.recipients : splitRecipients(body.recipients);
  const recipients = postedRecipients.length > 0 ? postedRecipients : state.defaultRecipients;
  const recipientSource = postedRecipients.length > 0 ? 'override' : 'resolved';
  const channelConfigured = state.channelConfigured && state.accounts.length > 0;
  const reason = recipients.length === 0 ? 'no_email_recipient' : channelConfigured ? undefined : 'no_email_channel';

  return {
    period: body.period === 'yearly' ? 'yearly' : state.period,
    from: '2026-09-01',
    to: '2026-09-30',
    today: '2026-10-01',
    enabled: state.enabled,
    sections,
    isEmpty: false,
    recipients,
    recipientSource,
    channel: channelConfigured
      ? { id: state.accounts[0].id, name: state.accounts[0].name, type: state.accounts[0].type, configured: true }
      : { id: null, name: null, type: null, configured: false },
    ...(reason ? { reason } : {}),
    data: {
      upcoming: has('upcoming')
        ? [{ id: 1, name: state.hostileUpcoming ? '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>' : '妈妈生日', type: 'birthday', date: '2026-10-05' }]
        : [],
      overdue: has('overdue') ? [{ kind: 'expiry', title: '域名续费', due: '2026-09-20', daysOverdue: 11 }] : [],
      spend: has('spend') ? { byCurrency: { CNY: 12345 }, onceByCurrency: {}, onceCount: 0 } : { byCurrency: {}, onceByCurrency: {}, onceCount: 0 },
      habits: has('habits') ? [{ name: '晨跑', logged: 3, target: 6, rate: 50 }] : [],
      medications: has('medications')
        ? { taken: 5, skipped: 1, missed: 0, total: 6, percentage: 83, perMedication: [{ name: '布洛芬', taken: 5, skipped: 1, missed: 0, total: 6, percentage: 83 }] }
        : { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, perMedication: [] },
      maintenance: has('maintenance') ? [{ assetName: '洗碗机', due: '2026-10-15', overdue: false }] : [],
      goals: has('goals') ? [{ title: '读完 12 本书', status: 'active', progress: 40, milestonesDone: 2, milestonesTotal: 5 }] : [],
    },
  };
}

async function setup(page: Page, options: SetupOptions = {}): Promise<DigestState> {
  const state: DigestState = {
    enabled: true,
    period: 'monthly',
    recipients: [],
    sections: [...ALL_SECTIONS],
    channelAccountId: null,
    defaultRecipients: ['me@example.com'],
    channelConfigured: true,
    accounts: [{ id: 1, type: 'resend', name: 'Resend 主账号', is_active: true }],
    hostileUpcoming: false,
    requests: [],
    lastPreviewBody: null,
    lastPreviewRecipients: null,
    ...options.state,
  };

  await page.addInitScript(
    ({ token, themeName }) => {
      localStorage.setItem('accessToken', token);
      if (themeName) localStorage.setItem('theme', themeName);
    },
    { token: 'e2e-digest-token', themeName: options.theme ?? '' },
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
    if (pathname === '/api/auth/turnstile-config') return json(route, { success: true, data: { siteKey: null, enabled: false } });

    // Settings page dependencies.
    if (pathname === '/api/config' && method === 'GET') {
      return json(route, { success: true, data: { timezone: 'Asia/Shanghai', reminder_emails: [], alert_account_ids: [] } });
    }
    if (pathname === '/api/config/accounts') return json(route, { success: true, data: state.accounts });
    if (pathname === '/api/email-logs') return json(route, { success: true, data: [] });
    if (pathname === '/api/calendar/integrations') return json(route, { success: true, data: {} });
    if (pathname === '/api/config/notification-advanced') return json(route, { success: true, data: {} });
    if (pathname === '/api/calendar/google-oauth/status') return json(route, { success: true, data: { configured: false, connected: false } });
    if (pathname === '/api/profiles') return json(route, { success: true, data: [] });
    if (pathname === '/api/inbox') return json(route, { success: true, data: [], pagination: { unreadCount: 0 } });

    // --- digest preferences ---
    if (pathname === '/api/config/digest' && method === 'GET') {
      return json(route, {
        success: true,
        data: {
          enabled: state.enabled,
          period: state.period,
          recipients: state.recipients,
          sections: state.sections,
          channelAccountId: state.channelAccountId,
        },
      });
    }
    if (pathname === '/api/config/digest' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      state.enabled = body.enabled !== false;
      state.period = body.period === 'yearly' ? 'yearly' : 'monthly';
      state.recipients = splitRecipients(body.recipients);
      state.sections = Array.isArray(body.sections) && body.sections.length > 0 ? (body.sections as string[]) : null;
      state.channelAccountId = typeof body.channelAccountId === 'number' ? body.channelAccountId : null;
      return json(route, {
        success: true,
        data: {
          enabled: state.enabled,
          period: state.period,
          recipients: state.recipients,
          sections: state.sections,
          channelAccountId: state.channelAccountId,
        },
      });
    }

    // --- digest preview / send ---
    if (pathname === '/api/digest/preview' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      state.lastPreviewBody = body;
      const preview = buildPreview(state, body);
      state.lastPreviewRecipients = preview.recipients;
      return json(route, { success: true, data: preview });
    }
    if (pathname === '/api/digest/send' && method === 'POST') {
      const channelConfigured = state.channelConfigured && state.accounts.length > 0;
      return json(route, {
        success: true,
        data: {
          userId: USER.id,
          period: 'monthly',
          from: '2026-09-01',
          to: '2026-09-30',
          emailed: channelConfigured,
          recipients: channelConfigured ? state.defaultRecipients : [],
          inbox: true,
          ...(channelConfigured ? {} : { reason: 'no_email_channel' }),
        },
      });
    }

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return state;
}

function writeEvidence(fileName: string, payload: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, `${fileName}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

async function openPreview(page: Page): Promise<void> {
  await page.getByTestId('digest-preview').click();
  await expect(page.getByTestId('digest-preview-modal')).toBeVisible();
  await expect(page.getByTestId('digest-preview-body')).toBeVisible();
}

test('happy path: toggle -> preview real data -> save -> reload persistence', async ({ page }) => {
  test.setTimeout(90_000);
  const state = await setup(page);

  await page.goto('/settings');
  await expect(page.getByTestId('digest-settings')).toBeVisible();

  // Toggle a few settings in the UI.
  await page.getByRole('switch', { name: '启用周期摘要' }).click(); // -> off
  await page.getByTestId('digest-period').selectOption('yearly');
  await page.getByTestId('digest-recipients').fill('ov@example.com');
  await page.getByTestId('digest-section-maintenance').click(); // exclude maintenance

  // Preview renders REAL data in the modal (before anything is sent).
  await openPreview(page);
  const modal = page.getByTestId('digest-preview-modal');
  await expect(page.getByTestId('digest-view-upcoming')).toContainText('妈妈生日');
  await expect(page.getByTestId('digest-view-goals')).toContainText('读完 12 本书');
  await expect(page.getByTestId('digest-preview-recipients')).toContainText('ov@example.com');
  await expect(modal).not.toContainText('正在生成预览');
  // The excluded section view is absent.
  await expect(page.getByTestId('digest-view-maintenance')).toHaveCount(0);
  // Preview must not send anything.
  expect(state.requests).not.toContain('POST /api/digest/send');
  // The preview request carried the CURRENT (unsaved) form values.
  expect(state.lastPreviewBody).toMatchObject({ period: 'yearly', recipients: ['ov@example.com'] });
  expect((state.lastPreviewBody?.sections as string[] | undefined) ?? []).not.toContain('maintenance');

  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();

  // Unsaved state is NOT persisted: reload reverts to the server's old row.
  await page.reload();
  await expect(page.getByRole('switch', { name: '启用周期摘要' })).toHaveAttribute('data-state', 'checked');
  await expect(page.getByTestId('digest-period')).toHaveValue('monthly');

  // Now save and reload: the settings survive from the server.
  await page.getByRole('switch', { name: '启用周期摘要' }).click(); // -> off
  await page.getByTestId('digest-period').selectOption('yearly');
  await page.getByTestId('digest-recipients').fill('ov@example.com');
  await page.getByTestId('digest-section-maintenance').click();
  await page.getByTestId('digest-save').click();
  await expect(page.getByTestId('digest-status')).toContainText('已保存');
  expect(state.enabled).toBe(false);
  expect(state.period).toBe('yearly');
  expect(state.recipients).toEqual(['ov@example.com']);
  expect(state.sections ?? []).not.toContain('maintenance');

  await page.reload();
  await expect(page.getByRole('switch', { name: '启用周期摘要' })).toHaveAttribute('data-state', 'unchecked');
  await expect(page.getByTestId('digest-period')).toHaveValue('yearly');
  await expect(page.getByTestId('digest-recipients')).toHaveValue('ov@example.com');
  await expect(page.getByTestId('digest-section-maintenance')).not.toHaveClass(/border-primary-500/);

  writeEvidence('task-80-playwright-happy', {
    persisted: {
      enabled: state.enabled,
      period: state.period,
      recipients: state.recipients,
      sections: state.sections,
    },
    requests: state.requests,
  });
});

test('negative control: a placeholder modal would fail the real-data assertion', async ({ page }) => {
  await setup(page);
  await page.goto('/settings');
  await expect(page.getByTestId('digest-settings')).toBeVisible();
  await openPreview(page);

  await expect(page.getByTestId('digest-preview-modal')).toContainText('妈妈生日');

  // Swap the modal body for a placeholder; the real-data assertion must now throw.
  await page.evaluate(() => {
    const body = document.querySelector('[data-testid="digest-preview-body"]');
    if (body) body.innerHTML = '<p>数据占位符</p>';
  });
  let threw = false;
  try {
    await expect(page.getByTestId('digest-preview-modal')).toContainText('妈妈生日');
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test('empty section selection falls back to ALL sections - never an empty digest', async ({ page }) => {
  await setup(page);
  await page.goto('/settings');
  await expect(page.getByTestId('digest-settings')).toBeVisible();

  await page.getByTestId('digest-sections-none').click();
  await openPreview(page);
  // Every section view renders, and the digest is not empty.
  for (const key of ALL_SECTIONS) {
    await expect(page.getByTestId(`digest-view-${key}`)).toBeVisible();
  }
  await expect(page.getByTestId('digest-preview-empty')).toHaveCount(0);
});

test('no email channel: preview still renders real data and explains the missing channel', async ({ page }) => {
  await setup(page, { state: { channelConfigured: false, accounts: [] } });
  await page.goto('/settings');
  await expect(page.getByTestId('digest-settings')).toBeVisible();
  await expect(page.getByTestId('digest-no-channel-hint')).toBeVisible();

  await openPreview(page);
  await expect(page.getByTestId('digest-view-upcoming')).toContainText('妈妈生日');
  await expect(page.getByTestId('digest-preview-channel-missing')).toContainText('未配置可用的邮件渠道');
  await page.keyboard.press('Escape');

  // The send action surfaces the SAME reason instead of failing silently.
  await page.getByTestId('digest-send').click();
  await expect(page.getByTestId('digest-status')).toContainText('没有可用的邮件渠道');
});

test('malformed + injection: 5 overrides render; hostile markup is inert and never a clean recipient', async ({ page }) => {
  const state = await setup(page, { state: { hostileUpcoming: true } });
  await page.goto('/settings');
  await expect(page.getByTestId('digest-settings')).toBeVisible();

  await page.getByTestId('digest-recipients').fill('a@x.com, b@x.com, c@x.com, d@x.com, e@x.com');
  await openPreview(page);
  const recipients = page.getByTestId('digest-preview-recipients');
  for (const email of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']) {
    await expect(recipients).toContainText(email);
  }
  await page.keyboard.press('Escape');

  // A hostile override must never yield a control-char-carrying recipient; the
  // hostiles simply fail the email shape and fall back to the default recipient.
  await page.getByTestId('digest-recipients').fill('evil@x.com\r\nBcc: bad@y.com <img src=x onerror="window.__xss=1">');
  await openPreview(page);
  const sanitizedRecipients = state.lastPreviewRecipients ?? [];
  expect(sanitizedRecipients.length).toBeGreaterThan(0);
  for (const email of sanitizedRecipients) {
    expect(email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(email).not.toContain('\r');
    expect(email).not.toContain('\n');
    expect(email).not.toContain('<');
  }

  // A hostile event name renders as INERT TEXT: the literal markup is visible but
  // no element executes and no script tag exists.
  const modal = page.getByTestId('digest-preview-modal');
  await expect(page.getByTestId('digest-view-upcoming')).toContainText('<img');
  await expect(modal.locator('img')).toHaveCount(0);
  await expect(modal.locator('script')).toHaveCount(0);
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss).toBeUndefined();
});

test('stale_state: on return the UI reflects the SERVER, not a stale local copy', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/settings');
  await expect(page.getByTestId('digest-settings')).toBeVisible();

  // Save: digest disabled, monthly.
  await page.getByRole('switch', { name: '启用周期摘要' }).click(); // -> off
  await page.getByTestId('digest-save').click();
  await expect(page.getByTestId('digest-status')).toContainText('已保存');
  expect(state.enabled).toBe(false);

  // Another device re-enables it and switches to yearly on the server.
  state.enabled = true;
  state.period = 'yearly';

  // Navigate away and return (remount => fresh GET /config/digest).
  await page.goto('/dashboard');
  await page.goto('/settings');
  await expect(page.getByTestId('digest-settings')).toBeVisible();
  await expect(page.getByRole('switch', { name: '启用周期摘要' })).toHaveAttribute('data-state', 'checked');
  await expect(page.getByTestId('digest-period')).toHaveValue('yearly');
});

for (const theme of ['light', 'dark'] as const) {
  test(`digest settings + preview visual snapshots (${theme})`, async ({ page }) => {
    test.setTimeout(90_000);
    await setup(page, { theme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.goto('/settings');
    const section = page.getByTestId('digest-settings');
    await expect(section).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await section.screenshot({ path: path.join(EVIDENCE_DIR, `task-80-digest-settings-${theme}.png`) });

    await openPreview(page);
    await page.waitForTimeout(300);
    await page.getByTestId('digest-preview-modal').screenshot({ path: path.join(EVIDENCE_DIR, `task-80-digest-preview-${theme}.png`) });
  });
}
