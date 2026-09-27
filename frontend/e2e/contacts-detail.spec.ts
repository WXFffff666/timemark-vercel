import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { addDaysIso, formatYmdLocal } from '../src/lib/contact-crm-utils';

/**
 * 个人 CRM 联系人详情抽屉（plan todo 63）端到端。
 *
 * - happy: 到期联系人 → 详情抽屉 → 「记录联系」→ 时间线出现条目 → 到期徽章清除 →
 *   设置 14 天节奏 → 下次联系日期渲染。
 * - failure: 零互动的联系人渲染空状态（不是 spinner、不崩溃）。
 * - adversarial 负向对照（证明断言有牙齿）：
 *   (1) 若记录后后端不推进 last_contact_at（ignoreInteractionsForDue），
 *       「到期徽章清除」断言必须失败；
 *   (2) 若时间线请求悬挂（hangTimeline），「空状态可见」断言必须失败（此时是 spinner）。
 * - adversarial 畸形输入：null 节奏、500、交互 400、2000 字摘要都不崩。
 * - prompt injection：联系人名/摘要里的 HTML/script 必须作为纯文本渲染。
 * - axe：抽屉打开时 390x844 与 1440x900 零 critical 违规。
 * - visual：浅/深色截图。
 *
 * dev build 跨域请求 http://localhost:3000/api，因此 mock 必须带 CORS 头。
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const USER = { id: 1, username: 'e2e-contacts-crm-user', role: 'admin', mustChangePassword: false };
const PAGE_LIMIT = 20;

interface ContactRow {
  id: number;
  user_id: number;
  name: string;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  gender: string | null;
  cadence_days: number | null;
  cadence_enabled: boolean;
  last_contact_at: string | null;
  validation_status: string;
  channel_account_ids: number[];
}

interface InteractionRow {
  id: number;
  user_id: number;
  contact_id: number;
  kind: string;
  occurred_at: string;
  summary: string | null;
  mood: string | null;
  created_at: string;
}

interface PromiseRow {
  id: number;
  contact_id: number;
  text: string;
  due_at: string | null;
  done_at: string | null;
  created_at: string;
}

interface GiftRow {
  id: number;
  contact_id: number;
  description: string;
  direction: string;
  occasion: string | null;
  amount_cents: number | null;
  occurred_at: string;
  created_at: string;
}

interface TimelineItem {
  type: 'interaction' | 'promise' | 'gift';
  id: number;
  at: string;
  interaction_kind: string | null;
  summary: string | null;
  mood: string | null;
  promise_text: string | null;
  due_at: string | null;
  done_at: string | null;
  gift_description: string | null;
  direction: string | null;
  occasion: string | null;
  amount_cents: number | null;
  created_at: string | null;
}

interface MockState {
  contacts: ContactRow[];
  interactions: InteractionRow[];
  promises: PromiseRow[];
  gifts: GiftRow[];
  requests: string[];
}

interface SetupOptions {
  contacts: Array<Partial<ContactRow> & { id: number; name: string }>;
  theme?: 'light' | 'dark';
  /** 模拟「记录后后端不推进 last_contact_at」→ 到期不消除（负向对照）。 */
  ignoreInteractionsForDue?: boolean;
  /** 时间线请求悬挂不响应 → 抽屉永远 loading（负向对照）。 */
  hangTimeline?: boolean;
  /** 时间线接口 500 → 错误状态。 */
  timeline500?: boolean;
  /** 交互接口 400（模拟未来时间被拒）→ 错误提示。 */
  interactionError?: boolean;
}

function contact(partial: Partial<ContactRow> & { id: number; name: string }): ContactRow {
  return {
    user_id: 1,
    nickname: null,
    email: null,
    phone: null,
    relationship: null,
    gender: 'unknown',
    cadence_days: null,
    cadence_enabled: false,
    last_contact_at: null,
    validation_status: 'valid',
    channel_account_ids: [],
    ...partial,
  };
}

function timelineFor(state: MockState, contactId: number): TimelineItem[] {
  const items: TimelineItem[] = [
    ...state.interactions
      .filter((i) => i.contact_id === contactId)
      .map((i) => ({
        type: 'interaction' as const,
        id: i.id,
        at: i.occurred_at,
        interaction_kind: i.kind,
        summary: i.summary,
        mood: i.mood,
        promise_text: null,
        due_at: null,
        done_at: null,
        gift_description: null,
        direction: null,
        occasion: null,
        amount_cents: null,
        created_at: i.created_at,
      })),
    ...state.promises
      .filter((p) => p.contact_id === contactId)
      .map((p) => ({
        type: 'promise' as const,
        id: p.id,
        at: p.done_at ?? (p.due_at ? `${p.due_at}T00:00:00.000Z` : p.created_at),
        interaction_kind: null,
        summary: null,
        mood: null,
        promise_text: p.text,
        due_at: p.due_at,
        done_at: p.done_at,
        gift_description: null,
        direction: null,
        occasion: null,
        amount_cents: null,
        created_at: p.created_at,
      })),
    ...state.gifts
      .filter((g) => g.contact_id === contactId)
      .map((g) => ({
        type: 'gift' as const,
        id: g.id,
        at: g.occurred_at,
        interaction_kind: null,
        summary: null,
        mood: null,
        promise_text: null,
        due_at: null,
        done_at: null,
        gift_description: g.description,
        direction: g.direction,
        occasion: g.occasion,
        amount_cents: g.amount_cents,
        created_at: g.created_at,
      })),
  ];
  items.sort((a, b) => {
    const diff = new Date(b.at).getTime() - new Date(a.at).getTime();
    if (diff !== 0) return diff;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return b.id - a.id;
  });
  return items;
}

/** Mirror of listDueContacts: cadence_enabled && cadence_days != null，且已到下次联系时间。 */
function dueRows(state: MockState, ignoreInteractions: boolean) {
  const now = Date.now();
  return state.contacts
    .filter((c) => c.cadence_enabled && c.cadence_days != null)
    .map((c) => {
      const latest = ignoreInteractions
        ? c.last_contact_at
        : state.interactions
            .filter((i) => i.contact_id === c.id)
            .map((i) => i.occurred_at)
            .sort()
            .slice(-1)[0] ?? c.last_contact_at;
      const effective = latest ?? c.last_contact_at;
      const next = effective ? addDaysIso(effective, c.cadence_days) : null;
      const isDue = effective == null || (next != null && new Date(next).getTime() <= now);
      return { c, effective, next, isDue };
    })
    .filter((row) => row.isDue)
    .map(({ c, effective, next }) => ({
      id: c.id,
      user_id: c.user_id,
      name: c.name,
      nickname: c.nickname,
      email: c.email,
      phone: c.phone,
      relationship: c.relationship,
      gender: c.gender,
      cadence_days: c.cadence_days,
      cadence_enabled: c.cadence_enabled,
      last_contact_at: c.last_contact_at,
      effective_last_contact_at: effective,
      next_due_at: next,
    }));
}

async function setup(page: Page, options: SetupOptions): Promise<MockState> {
  const state: MockState = {
    contacts: options.contacts.map(contact),
    interactions: [],
    promises: [],
    gifts: [],
    requests: [],
  };
  let nextInteractionId = 1;
  let nextPromiseId = 1;
  let nextGiftId = 1;

  await page.addInitScript(
    ({ token, themeName }) => {
      localStorage.setItem('accessToken', token);
      if (themeName) localStorage.setItem('theme', themeName);
    },
    { token: 'e2e-contacts-crm-token', themeName: options.theme ?? '' },
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
    const url = new URL(req.url());
    const pathname = url.pathname;
    state.requests.push(`${method} ${pathname}`);

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') return json(route, { success: true, data: { siteKey: null, enabled: false } });
    if (pathname === '/api/config/accounts') return json(route, { success: true, data: [] });
    if (pathname === '/api/contacts/groups') return json(route, { success: true, data: { groups: [], members: [] } });
    if (pathname === '/api/contacts/due') return json(route, { success: true, data: dueRows(state, Boolean(options.ignoreInteractionsForDue)) });

    const timelineMatch = /^\/api\/contacts\/(\d+)\/timeline$/.exec(pathname);
    if (timelineMatch && method === 'GET') {
      if (options.hangTimeline) return; // stalled → UI stays loading
      if (options.timeline500) return json(route, { success: false, error: 'internal error' }, 500);
      const contactId = Number(timelineMatch[1]);
      const all = timelineFor(state, contactId);
      const pageNum = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? String(PAGE_LIMIT), 10) || PAGE_LIMIT));
      const start = (pageNum - 1) * limit;
      const slice = all.slice(start, start + limit);
      return json(route, {
        success: true,
        data: slice,
        pagination: { page: pageNum, limit, total: all.length, totalPages: Math.ceil(all.length / limit) },
      });
    }

    const interactionsMatch = /^\/api\/contacts\/(\d+)\/interactions$/.exec(pathname);
    if (interactionsMatch && method === 'POST') {
      if (options.interactionError) return json(route, { success: false, error: '互动时间不能晚于当前时间' }, 400);
      const contactId = Number(interactionsMatch[1]);
      const body = (req.postDataJSON() ?? {}) as { kind?: string; occurredAt?: string; summary?: string; mood?: string };
      if (body.occurredAt && Date.parse(body.occurredAt) > Date.now() + 5 * 60 * 1000) {
        return json(route, { success: false, error: '互动时间不能晚于当前时间' }, 400);
      }
      const nowIso = new Date().toISOString();
      const row: InteractionRow = {
        id: nextInteractionId++,
        user_id: 1,
        contact_id: contactId,
        kind: String(body.kind ?? 'other'),
        occurred_at: body.occurredAt ?? nowIso,
        summary: body.summary ?? null,
        mood: body.mood ?? null,
        created_at: nowIso,
      };
      state.interactions.push(row);
      if (!options.ignoreInteractionsForDue) {
        const target = state.contacts.find((c) => c.id === contactId);
        if (target && (!target.last_contact_at || target.last_contact_at < row.occurred_at)) {
          target.last_contact_at = row.occurred_at;
        }
      }
      return json(route, { success: true, data: row }, 201);
    }

    const promisesMatch = /^\/api\/contacts\/(\d+)\/promises$/.exec(pathname);
    if (promisesMatch && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as { text?: string; dueAt?: string | null };
      const row: PromiseRow = {
        id: nextPromiseId++,
        contact_id: Number(promisesMatch[1]),
        text: String(body.text ?? ''),
        due_at: body.dueAt ?? null,
        done_at: null,
        created_at: new Date().toISOString(),
      };
      state.promises.push(row);
      return json(route, { success: true, data: row }, 201);
    }

    const giftsMatch = /^\/api\/contacts\/(\d+)\/gifts$/.exec(pathname);
    if (giftsMatch && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as { description?: string; direction?: string; occasion?: string | null; amountCents?: number | null };
      const row: GiftRow = {
        id: nextGiftId++,
        contact_id: Number(giftsMatch[1]),
        description: String(body.description ?? ''),
        direction: String(body.direction ?? 'given'),
        occasion: body.occasion ?? null,
        amount_cents: body.amountCents ?? null,
        occurred_at: new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString(),
      };
      state.gifts.push(row);
      return json(route, { success: true, data: row }, 201);
    }

    const contactMatch = /^\/api\/contacts\/(\d+)$/.exec(pathname);
    if (contactMatch && method === 'PUT') {
      const id = Number(contactMatch[1]);
      const target = state.contacts.find((c) => c.id === id);
      if (!target) return json(route, { success: false, error: '联系人不存在' }, 404);
      const body = (req.postDataJSON() ?? {}) as { cadenceDays?: number | null; cadenceEnabled?: boolean };
      if (body.cadenceDays !== undefined) target.cadence_days = body.cadenceDays;
      if (body.cadenceEnabled !== undefined) target.cadence_enabled = body.cadenceEnabled;
      return json(route, { success: true, data: target });
    }

    if (pathname === '/api/contacts' && method === 'GET') return json(route, { success: true, data: state.contacts });

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return state;
}

/** 打开某个联系人的详情抽屉。 */
async function openDrawer(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`查看 ${name}.*详情`) }).first().click();
  await expect(page.getByTestId('contact-detail-drawer')).toBeVisible();
}

function writeEvidence(fileName: string, payload: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, `${fileName}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

test('contacts CRM happy path: log interaction -> timeline entry, due badge clears, cadence next-due renders', async ({ page }) => {
  test.setTimeout(90_000);
  const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const state = await setup(page, {
    contacts: [
      contact({
        id: 11,
        name: '王小明',
        nickname: '明明',
        relationship: 'mother',
        gender: 'female',
        cadence_days: 30,
        cadence_enabled: true,
        last_contact_at: fortyDaysAgo,
      }),
    ],
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();

  // 到期徽章先出现在列表行上。
  await expect(page.getByTestId('contact-due-badge-11')).toBeVisible();

  await openDrawer(page, '王小明');
  const drawer = page.getByTestId('contact-detail-drawer');
  await expect(drawer.getByTestId('contact-due-badge')).toBeVisible();

  // 零互动 → 时间线是空状态（不是 spinner）。
  await expect(drawer.getByTestId('contact-timeline-empty')).toBeVisible();
  await expect(drawer.getByTestId('contact-timeline-loading')).toHaveCount(0);

  // 记录一次电话联系。
  await drawer.getByLabel('互动备注').fill('打电话聊了家常');
  await drawer.getByRole('button', { name: '记录联系：打电话' }).click();

  const entry = drawer.getByTestId('timeline-entry-interaction-1');
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('电话联系');
  await expect(entry).toContainText('打电话聊了家常');

  // 到期徽章必须清除（列表行 + 抽屉）。
  await expect(page.getByTestId('contact-due-badge-11')).toHaveCount(0);
  await expect(drawer.getByTestId('contact-due-badge')).toHaveCount(0);
  expect(state.interactions).toHaveLength(1);

  // 设置 14 天节奏 → 下次联系日期渲染。
  await drawer.getByLabel('节奏周期').selectOption('14');
  await drawer.getByRole('button', { name: '保存联系节奏' }).click();
  await expect(drawer.getByTestId('contact-cadence-label')).toHaveText('每两周');

  const loggedAt = state.interactions[0].occurred_at;
  const expectedNextDue = formatYmdLocal(addDaysIso(loggedAt, 14));
  await expect(drawer.getByTestId('contact-next-due')).toHaveText(expectedNextDue);
  expect(state.contacts[0].cadence_days).toBe(14);

  writeEvidence('task-63-happy-state', {
    interactions: state.interactions,
    cadence_days: state.contacts[0].cadence_days,
    last_contact_at: state.contacts[0].last_contact_at,
    expectedNextDue,
    requests: state.requests,
  });
});

test('contacts CRM failure: a contact with zero interactions renders a real empty state (not a spinner or crash)', async ({ page }) => {
  await setup(page, { contacts: [contact({ id: 21, name: '李雷', relationship: 'friend' })] });

  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();
  await openDrawer(page, '李雷');
  const drawer = page.getByTestId('contact-detail-drawer');

  await expect(drawer.getByTestId('contact-timeline-empty')).toBeVisible();
  await expect(drawer.getByTestId('contact-timeline-loading')).toHaveCount(0);
  await expect(drawer.getByTestId('contact-timeline')).toHaveCount(0);
  await expect(drawer.getByTestId('contact-timeline-error')).toHaveCount(0);
  // The page is still alive (no crash). Radix marks background content aria-hidden while the
  // modal drawer is open, so use a CSS locator rather than getByRole here.
  await expect(page.locator('h1', { hasText: '固定联系人' })).toBeVisible();
});

test('adversarial: the due-badge-clear assertion has teeth (a backend that never advances last_contact_at leaves the badge up)', async ({ page }) => {
  test.setTimeout(90_000);
  const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();

  // Control run: stale backend. Logging an interaction must NOT clear the badge,
  // therefore the happy-path assertion `toHaveCount(0)` would fail here.
  await setup(page, {
    ignoreInteractionsForDue: true,
    contacts: [
      contact({ id: 31, name: '韩梅梅', cadence_days: 30, cadence_enabled: true, last_contact_at: fortyDaysAgo }),
    ],
  });

  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();
  await expect(page.getByTestId('contact-due-badge-31')).toBeVisible();

  await openDrawer(page, '韩梅梅');
  const drawer = page.getByTestId('contact-detail-drawer');
  await drawer.getByLabel('互动备注').fill('记录一笔，但后端不会推进 last_contact_at');
  await drawer.getByRole('button', { name: '记录联系：打电话' }).click();
  await expect(drawer.getByTestId('timeline-entry-interaction-1')).toBeVisible();

  // NEGATIVE CONTROL: badge stays. This is exactly the state in which the
  // happy-path `expect(badge).toHaveCount(0)` would fail → the assertion is not vacuous.
  await expect(drawer.getByTestId('contact-due-badge')).toBeVisible();
  await expect(page.getByTestId('contact-due-badge-31')).toBeVisible();
});

test('adversarial: the empty-state assertion has teeth (a hung timeline shows a spinner, not the empty state)', async ({ page }) => {
  await setup(page, {
    hangTimeline: true,
    contacts: [contact({ id: 41, name: '悬挂加载', relationship: 'friend' })],
  });

  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();
  await openDrawer(page, '悬挂加载');
  const drawer = page.getByTestId('contact-detail-drawer');

  // The timeline is stuck loading → spinner visible, empty state absent.
  await expect(drawer.getByTestId('contact-timeline-loading')).toBeVisible();
  await expect(drawer.getByTestId('contact-timeline-empty')).toHaveCount(0);

  // Running the happy empty-state assertion here must THROW, proving it is meaningful.
  let assertionFailed = false;
  try {
    await expect(drawer.getByTestId('contact-timeline-empty')).toBeVisible({ timeout: 1500 });
  } catch {
    assertionFailed = true;
  }
  expect(assertionFailed).toBe(true);
});

test('adversarial malformed: null cadence and a 500 timeline render safely without a crash', async ({ page }) => {
  await setup(page, {
    timeline500: true,
    contacts: [contact({ id: 51, name: '无节奏', cadence_days: null, cadence_enabled: false })],
  });

  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();
  await openDrawer(page, '无节奏');
  const drawer = page.getByTestId('contact-detail-drawer');

  // null cadence → 未设置, no crash, no next-due element.
  await expect(drawer.getByTestId('contact-cadence-label')).toHaveText('未设置');
  await expect(drawer.getByTestId('contact-next-due')).toHaveCount(0);

  // 500 timeline → error state with retry, still no crash.
  await expect(drawer.getByTestId('contact-timeline-error')).toBeVisible();
  await expect(drawer.getByTestId('contact-timeline-empty')).toHaveCount(0);
  await expect(page.locator('h1', { hasText: '固定联系人' })).toBeVisible();
});

test('adversarial malformed: a rejected interaction and a 2000-char summary do not crash', async ({ page }) => {
  test.setTimeout(90_000);
  const longSummary = '很长的备注'.repeat(400).slice(0, 2000);
  const state = await setup(page, {
    interactionError: true,
    contacts: [contact({ id: 61, name: '长文测试', cadence_days: 30, cadence_enabled: true })],
  });
  state.interactions.push({
    id: 500,
    user_id: 1,
    contact_id: 61,
    kind: 'message',
    occurred_at: new Date().toISOString(),
    summary: longSummary,
    mood: null,
    created_at: new Date().toISOString(),
  });

  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();
  await openDrawer(page, '长文测试');
  const drawer = page.getByTestId('contact-detail-drawer');

  // A 2000-char summary renders as wrapped text (no overflow/crash).
  const longEntry = drawer.getByTestId('timeline-entry-interaction-500');
  await expect(longEntry).toBeVisible();
  await expect(longEntry).toContainText(longSummary.slice(0, 40));
  await expect(drawer).toBeVisible();

  // A future-dated / rejected interaction surfaces the API error and keeps the drawer alive.
  await drawer.getByRole('button', { name: '记录联系：见面' }).click();
  await expect(drawer.getByTestId('contact-detail-error')).toContainText('互动时间不能晚于当前时间');
  expect(state.interactions).toHaveLength(1); // only the seeded long one
  await expect(page.locator('h1', { hasText: '固定联系人' })).toBeVisible();
});

test('adversarial prompt injection: a hostile contact name and summary render as inert text', async ({ page }) => {
  const hostileName = '<img src=x onerror="window.__xss=1">';
  const hostileSummary = '<script>window.__xss=1</script><b>bold</b>';
  await setup(page, { contacts: [contact({ id: 71, name: hostileName, relationship: 'friend' })] });

  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();
  await openDrawer(page, hostileName);
  const drawer = page.getByTestId('contact-detail-drawer');

  await drawer.getByLabel('互动备注').fill(hostileSummary);
  await drawer.getByRole('button', { name: '记录联系：发消息' }).click();
  await expect(drawer.getByTestId('timeline-entry-interaction-1')).toBeVisible();

  // The markup is inert text: no injected image, no executed script, no <b> element.
  await expect(drawer.locator('img')).toHaveCount(0);
  await expect(drawer.locator('b')).toHaveCount(0);
  await expect(drawer).toContainText(hostileSummary);
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss).toBeUndefined();
});

test('contacts CRM pagination: page 2 loads the rest of a 25-entry timeline', async ({ page }) => {
  test.setTimeout(90_000);
  const state = await setup(page, { contacts: [contact({ id: 81, name: '多说几句', relationship: 'colleague' })] });
  for (let i = 0; i < 25; i += 1) {
    state.interactions.push({
      id: 100 + i,
      user_id: 1,
      contact_id: 81,
      kind: 'message',
      occurred_at: new Date(Date.now() - i * 3_600_000).toISOString(),
      summary: `第 ${i + 1} 次消息`,
      mood: null,
      created_at: new Date().toISOString(),
    });
  }

  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();
  await openDrawer(page, '多说几句');
  const drawer = page.getByTestId('contact-detail-drawer');

  await expect(drawer.locator('[data-testid^="timeline-entry-interaction-"]')).toHaveCount(20);
  await expect(drawer.getByRole('button', { name: '加载更早的记录' })).toBeVisible();
  await drawer.getByRole('button', { name: '加载更早的记录' }).click();
  await expect(drawer.locator('[data-testid^="timeline-entry-interaction-"]')).toHaveCount(25);
});

for (const viewport of [
  { id: '390x844', width: 390, height: 844 },
  { id: '1440x900', width: 1440, height: 900 },
] as const) {
  test(`a11y drawer: zero critical Axe violations at ${viewport.id}`, async ({ page }) => {
    test.setTimeout(90_000);
    const state = await setup(page, {
      contacts: [
        contact({ id: 91, name: '无障碍检查', relationship: 'friend', cadence_days: 30, cadence_enabled: true, last_contact_at: new Date(Date.now() - 40 * 86_400_000).toISOString() }),
      ],
    });
    state.interactions.push({
      id: 1,
      user_id: 1,
      contact_id: 91,
      kind: 'call',
      occurred_at: new Date().toISOString(),
      summary: '一次电话',
      mood: null,
      created_at: new Date().toISOString(),
    });

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();
    await openDrawer(page, '无障碍检查');
    await expect(page.getByTestId('timeline-entry-interaction-1')).toBeVisible();
    await page.waitForTimeout(400);

    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((v) => v.impact === 'critical');
    writeEvidence(`task-63-axe-drawer-${viewport.id}`, {
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
  test(`contacts CRM visual snapshot (${theme})`, async ({ page }) => {
    test.setTimeout(90_000);
    const state = await setup(page, {
      theme,
      contacts: [
        contact({
          id: 101,
          name: '王小明',
          nickname: '明明',
          relationship: 'mother',
          gender: 'female',
          cadence_days: 14,
          cadence_enabled: true,
          last_contact_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        }),
      ],
    });
    state.interactions.push(
      { id: 1, user_id: 1, contact_id: 101, kind: 'call', occurred_at: new Date(Date.now() - 3_600_000).toISOString(), summary: '打电话聊了家常', mood: null, created_at: new Date().toISOString() },
      { id: 2, user_id: 1, contact_id: 101, kind: 'meal', occurred_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), summary: '一起吃了火锅', mood: null, created_at: new Date().toISOString() },
    );
    state.promises.push({ id: 1, contact_id: 101, text: '答应帮对方带一本书', due_at: null, done_at: null, created_at: new Date(Date.now() - 86_400_000).toISOString() });
    state.gifts.push({ id: 1, contact_id: 101, description: '围巾', direction: 'given', occasion: '生日', amount_cents: 19900, occurred_at: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10), created_at: new Date().toISOString() });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { name: '固定联系人' })).toBeVisible();
    await openDrawer(page, '王小明');
    await expect(page.getByTestId('timeline-entry-gift-1')).toBeVisible();
    await page.waitForTimeout(400);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-63-contacts-detail-${theme}.png`), fullPage: true });
  });
}
