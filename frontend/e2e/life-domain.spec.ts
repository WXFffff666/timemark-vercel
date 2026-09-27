import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Wave 7（D1 到期中心 / D2 证件保险箱 / D12 库存+保养）life-domain smoke flow — todo 59.
 *
 * Verification-only spec（本 todo 不添加任何产品代码）。真实 UI（Vite dev build）打在
 * 有状态 API mock 上；mock 忠实复刻 backend 路由契约与提醒引擎（runDatedReminderIterator /
 * sendMaintenanceUsageNudges 的语义：到期日、提前天数、±2 分钟窗口、reminder_send_claims 去重、
 * 过去日期不提醒、用量提醒写 source='inbound' 收件箱消息）。wave7d-59 修复后，
 * 无 reminder_config 的条目在解析渠道时回退到用户已启用渠道（默认兜底），mock 同步模拟。
 *
 * - happy: 干净状态 → UI 创建 到期项(临期+已逾期) / 证件(护照+在职证明，护照带号码+PDF 附件) /
 *   库存(牛奶低库存+临期、纸巾无保质期) / 保养计划(日期+用量)；经 UI 与 API 断言
 *   upcoming/overdue/low-stock/expiring 查询；触发同一提醒引擎并断言四个领域各自派发、
 *   已逾期项不派发、用量提醒出现在「收件箱」。
 * - failure: 流程中删除一个到期项 → 触发提醒检查 → 断言其提醒 **不发射**（ABSENCE），
 *   同一日期/同一配置的存活孪生项照常发射（presence control，保证断言非空洞）。
 *   环境变量 LIFE_DOMAIN_MUTATION=keep-deleted-reminders 时 mock 模拟「删除后仍参与提醒」的
 *   回归（读取全部隐藏该行，只有提醒引擎仍能看到它）→ 本 spec 的 ABSENCE 断言必须失败
 *   （adversarial 证据见 .omo/evidence/task-59-*.txt）。
 *
 * dev build 跨域请求 http://localhost:3000/api，因此 mock 必须带 CORS 头。
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const USER = { id: 1, username: 'e2e-life-domain-user', role: 'admin', mustChangePassword: false };
const MUTATION = process.env.LIFE_DOMAIN_MUTATION ?? '';
const EVIDENCE_SUFFIX = process.env.LIFE_DOMAIN_EVIDENCE_SUFFIX ?? '';

// ---------------------------------------------------------------------------
// date helpers（Asia/Shanghai，无 DST；引擎窗口按用户时区）
// ---------------------------------------------------------------------------

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiYmd(now: Date): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function shanghaiHHmm(now: Date): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(11, 16);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function diffYmd(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T00:00:00Z`);
  const to = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

function matchesWindow(current: string, target: string): boolean {
  const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return Math.abs(toMinutes(current) - toMinutes(target)) <= 2;
}

// ---------------------------------------------------------------------------
// mock 状态与行形状（对齐 backend services 的 wire 形状）
// ---------------------------------------------------------------------------

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
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  /** 仅 mutation 回归模拟使用：读取路径隐藏该行，提醒引擎仍可见。 */
  deleted?: boolean;
}

interface DocRow {
  id: number;
  user_id: number;
  profile_id: number | null;
  kind: string;
  title: string;
  issuer: string | null;
  issued_at: string | null;
  expires_at: string | null;
  country: string | null;
  notes: string | null;
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  numberConfigured: boolean;
}

interface AttachmentRow {
  id: number;
  owner_type: string;
  owner_id: number;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
  download_url: string;
}

interface InvRow {
  id: number;
  user_id: number;
  profile_id: number | null;
  name: string;
  category: string;
  quantity: number;
  unit: string | null;
  low_stock_threshold: number | null;
  purchased_at: string | null;
  expires_at: string | null;
  location: string | null;
  notes: string | null;
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  id: number;
  user_id: number;
  profile_id: number | null;
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
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface InboxMessage {
  id: number;
  title: string;
  body: string;
  source: 'inbound' | 'notification' | 'broadcast';
  channel: string | null;
  sender_label: string | null;
  is_read: boolean;
  created_at: string;
}

interface DispatchedReminder {
  source: string;
  id: number;
  title: string;
  key: string;
}

interface DatedSourceResult {
  candidates: number;
  sent: number;
  claimed: number;
  skipped: number;
  dispatched: DispatchedReminder[];
}

interface ReminderCheckResult {
  at: string;
  timezone: string;
  dated: Record<'expiry' | 'document' | 'inventory' | 'maintenance', DatedSourceResult>;
  usage: { candidates: number; nudged: number; skipped: number };
}

interface MockState {
  expiry: ExpiryRow[];
  documents: DocRow[];
  attachments: AttachmentRow[];
  numbers: Map<number, string>;
  inventory: InvRow[];
  plans: PlanRow[];
  inbox: InboxMessage[];
  claims: Set<string>;
  dispatches: DispatchedReminder[];
  requests: string[];
  nextInboxId: number;
  /** 用户已启用的通知账户类型（resolveReminderChannels 的默认兜底渠道）。 */
  defaultChannels: string[];
}

// ---------------------------------------------------------------------------
// 提醒引擎 mirror（与 backend/src/jobs/tasks.ts 的语义逐条对应）
// ---------------------------------------------------------------------------

const DEFAULT_LEAD_DAYS: readonly number[] = [30, 7, 3, 1, 0];
const DOC_LEAD_DAYS_LONG: readonly number[] = [180, 90, 30, 7, 0];
const DOC_LEAD_DAYS_SHORT: readonly number[] = [90, 30, 7, 0];
const DEFAULT_REMINDER_TIMES: readonly string[] = ['09:00'];
const USAGE_NUDGE_RATIO = 0.1;

interface DatedMirrorSource {
  label: 'expiry' | 'document' | 'inventory' | 'maintenance';
  rows: Array<Record<string, unknown>>;
  dueField: string;
  titleField: string;
  kindField: string;
  defaultKind: string;
  leadDays: (kind: string) => readonly number[];
  prefix: string;
  buildExpiredKey?: (due: string) => string;
}

function runDatedMirror(state: MockState, source: DatedMirrorSource, now: Date): DatedSourceResult {
  const today = shanghaiYmd(now);
  const currentTime = shanghaiHHmm(now);
  let sent = 0;
  let claimed = 0;
  let skipped = 0;
  const dispatched: DispatchedReminder[] = [];

  for (const row of source.rows) {
    if (row.is_active === false) {
      skipped += 1;
      continue;
    }
    const dueRaw = row[source.dueField];
    const due = typeof dueRaw === 'string' ? dueRaw : null;
    if (!due) {
      skipped += 1;
      continue;
    }
    const daysUntil = diffYmd(today, due);
    const config = (row.reminder_config ?? null) as {
      enabled?: boolean;
      daysBeforeList?: number[];
      reminderTimes?: string[];
      channels?: string[];
    } | null;
    if (config?.enabled === false) {
      skipped += 1;
      continue;
    }
    const kind = String(row[source.kindField] ?? source.defaultKind);
    const isExpired = daysUntil < 0;
    if (isExpired && !source.buildExpiredKey) {
      // 过去日期不是「即将到来」：逾期项由各自视图呈现，不发提醒
      skipped += 1;
      continue;
    }
    const leads = config?.daysBeforeList?.length ? config.daysBeforeList : [...source.leadDays(kind)];
    if (!isExpired && !leads.includes(daysUntil)) {
      skipped += 1;
      continue;
    }
    const times = config?.reminderTimes?.length ? config.reminderTimes : [...DEFAULT_REMINDER_TIMES];
    const matchedTime = times.find((time) => matchesWindow(currentTime, time));
    if (!matchedTime) {
      skipped += 1;
      continue;
    }
    const explicitChannels = Array.isArray(config?.channels) ? config.channels : [];
    // resolveReminderChannels 的兜底：条目无显式渠道时走用户已启用渠道，
    // 因此 UI 创建的「无 reminder_config」条目也会派发（wave7d-59 issue 2）。
    const channels = explicitChannels.length > 0 ? explicitChannels : state.defaultChannels;
    if (channels.length === 0) {
      // 用户连一个启用渠道都没有（notification_accounts 全空）：无处可送，跳过
      skipped += 1;
      continue;
    }
    const key = isExpired
      ? (source.buildExpiredKey as (dueYmd: string) => string)(due)
      : `${source.prefix}:${today}#d${daysUntil}#t${matchedTime}`;
    const claimId = `${row.id}#${key}`;
    if (state.claims.has(claimId)) {
      skipped += 1;
      continue;
    }
    state.claims.add(claimId);
    claimed += 1;
    const title = String(row[source.titleField] ?? '');
    const entry: DispatchedReminder = { source: source.label, id: Number(row.id), title, key };
    state.dispatches.push(entry);
    dispatched.push(entry);
    sent += 1;
  }

  return { candidates: source.rows.length, sent, claimed, skipped, dispatched };
}

/** mirror of sendMaintenanceUsageNudges：临近用量 → 写 source='inbound' 的收件箱消息。 */
function runUsageNudgesMirror(state: MockState, now: Date): { candidates: number; nudged: number; skipped: number } {
  let nudged = 0;
  let skipped = 0;
  let candidates = 0;
  for (const plan of state.plans) {
    if (plan.is_active === false) continue;
    const { interval_usage: intervalUsage, current_usage: currentUsage, next_due_usage: nextDueUsage } = plan;
    if (intervalUsage == null || currentUsage == null || nextDueUsage == null) continue;
    candidates += 1;
    const remaining = nextDueUsage - currentUsage;
    if (!(remaining <= intervalUsage * USAGE_NUDGE_RATIO)) {
      skipped += 1;
      continue;
    }
    const key = `maintenance:usage#${plan.id}#u${nextDueUsage}`;
    const claimId = `${plan.id}#${key}`;
    if (state.claims.has(claimId)) {
      skipped += 1;
      continue;
    }
    state.claims.add(claimId);
    const unit = plan.usage_unit ?? '';
    state.inbox.push({
      id: state.nextInboxId++,
      title: `保养提醒：${plan.asset_name}`,
      body: `按用量保养临近：当前 ${currentUsage}${unit}，下次保养 ${nextDueUsage}${unit}（剩余 ${remaining}${unit}）`,
      source: 'inbound',
      channel: null,
      sender_label: '保养计划',
      is_read: false,
      created_at: now.toISOString(),
    });
    nudged += 1;
  }
  return { candidates, nudged, skipped };
}

function runReminderCheck(state: MockState, now: Date): ReminderCheckResult {
  const dated = {
    expiry: runDatedMirror(state, {
      label: 'expiry',
      rows: state.expiry as unknown as Array<Record<string, unknown>>,
      dueField: 'next_due_date',
      titleField: 'title',
      kindField: 'kind',
      defaultKind: 'custom',
      leadDays: () => DEFAULT_LEAD_DAYS,
      prefix: 'expiry',
    }, now),
    document: runDatedMirror(state, {
      label: 'document',
      rows: state.documents as unknown as Array<Record<string, unknown>>,
      dueField: 'expires_at',
      titleField: 'title',
      kindField: 'kind',
      defaultKind: 'other',
      leadDays: (kind) => (kind === 'passport' || kind === 'visa' ? DOC_LEAD_DAYS_LONG : DOC_LEAD_DAYS_SHORT),
      prefix: 'document',
      buildExpiredKey: (due) => `document:expired#${due}`,
    }, now),
    inventory: runDatedMirror(state, {
      label: 'inventory',
      rows: state.inventory as unknown as Array<Record<string, unknown>>,
      dueField: 'expires_at',
      titleField: 'name',
      kindField: 'category',
      defaultKind: 'other',
      leadDays: () => DEFAULT_LEAD_DAYS,
      prefix: 'inventory',
    }, now),
    maintenance: runDatedMirror(state, {
      label: 'maintenance',
      rows: state.plans as unknown as Array<Record<string, unknown>>,
      dueField: 'next_due_at',
      titleField: 'asset_name',
      kindField: 'asset_kind',
      defaultKind: 'other',
      leadDays: () => DEFAULT_LEAD_DAYS,
      prefix: 'maintenance',
    }, now),
  };
  const usage = runUsageNudgesMirror(state, now);
  return { at: now.toISOString(), timezone: 'Asia/Shanghai', dated, usage };
}

// ---------------------------------------------------------------------------
// mock API（有状态；从干净状态开始）
// ---------------------------------------------------------------------------

const emptyCosts = {
  totalCents: 0,
  currency: null,
  mixedCurrencies: false,
  byCurrency: {},
  byKind: [],
  monthly: [],
  once: { totalCents: 0, currency: null, byCurrency: {}, count: 0 },
};

function visibleExpiry(state: MockState): ExpiryRow[] {
  return state.expiry.filter((row) => !row.deleted);
}

function rowFromExpiryBody(id: number, body: Record<string, unknown>): ExpiryRow {
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
    reminder_config: (body.reminderConfig ?? null) as Record<string, unknown> | null,
    is_active: body.isActive !== false,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

async function setup(page: Page): Promise<MockState> {
  const state: MockState = {
    expiry: [],
    documents: [],
    attachments: [],
    numbers: new Map<number, string>(),
    inventory: [],
    plans: [],
    inbox: [],
    claims: new Set<string>(),
    dispatches: [],
    requests: [],
    nextInboxId: 1,
    // 用户在「通知渠道」页配置了一个启用的通用 Webhook 账户
    defaultChannels: ['generic_webhook'],
  };
  let nextExpiryId = 1;
  let nextDocId = 1;
  let nextAttachmentId = 1;
  let nextInvId = 1;
  let nextPlanId = 1;

  await page.addInitScript((token) => {
    localStorage.setItem('accessToken', token);
  }, 'e2e-life-domain-token');

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
    state.requests.push(`${method} ${pathname}${url.search}`);
    const today = shanghaiYmd(new Date());

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') return json(route, { success: true, data: { siteKey: null, enabled: false } });

    // ---- reminder engine (cron mirror) ----
    if (pathname === '/api/cron/reminder-check' && method === 'GET') {
      const at = url.searchParams.get('at');
      const result = runReminderCheck(state, at ? new Date(at) : new Date());
      return json(route, { success: true, data: result });
    }

    // ---- /api/expiry ----
    if (pathname === '/api/expiry/upcoming' && method === 'GET') {
      const days = Number(url.searchParams.get('days') ?? '30') || 30;
      const limit = addDaysYmd(today, days);
      const rows = visibleExpiry(state).filter(
        (row) => row.is_active && row.next_due_date >= today && row.next_due_date <= limit,
      );
      return json(route, { success: true, data: rows, days });
    }
    if (pathname === '/api/expiry/overdue' && method === 'GET') {
      const rows = visibleExpiry(state).filter((row) => row.is_active && row.next_due_date < today);
      return json(route, { success: true, data: rows });
    }
    if (pathname === '/api/expiry/costs') return json(route, { success: true, data: emptyCosts });
    const expiryMatch = /^\/api\/expiry\/(\d+)$/.exec(pathname);
    if (expiryMatch) {
      const id = Number(expiryMatch[1]);
      const row = visibleExpiry(state).find((candidate) => candidate.id === id);
      if (method === 'DELETE') {
        if (!row) return json(route, { success: false, error: '到期项不存在' }, 404);
        if (MUTATION === 'keep-deleted-reminders') {
          // 回归模拟：读取路径隐藏，提醒引擎（state.expiry 原文扫描）仍能看到它。
          row.deleted = true;
        } else {
          state.expiry = state.expiry.filter((candidate) => candidate.id !== id);
        }
        return json(route, { success: true });
      }
      if (method === 'PATCH') {
        if (!row) return json(route, { success: false, error: '到期项不存在' }, 404);
        const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
        if (body.reminderConfig !== undefined) row.reminder_config = body.reminderConfig as Record<string, unknown> | null;
        if (typeof body.title === 'string') row.title = body.title;
        row.updated_at = new Date().toISOString();
        return json(route, { success: true, data: row });
      }
      if (method === 'GET') {
        return row
          ? json(route, { success: true, data: row })
          : json(route, { success: false, error: '到期项不存在' }, 404);
      }
    }
    if (pathname === '/api/expiry' && method === 'GET') {
      const kind = url.searchParams.get('kind');
      const active = url.searchParams.get('active');
      const q = url.searchParams.get('q');
      let list = visibleExpiry(state).slice();
      if (kind) list = list.filter((row) => row.kind === kind);
      if (active === 'true') list = list.filter((row) => row.is_active);
      if (active === 'false') list = list.filter((row) => !row.is_active);
      if (q) {
        const needle = q.toLowerCase();
        list = list.filter((row) => `${row.title} ${row.vendor ?? ''}`.toLowerCase().includes(needle));
      }
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 200, total: list.length, totalPages: 1 } });
    }
    if (pathname === '/api/expiry' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const row = rowFromExpiryBody(nextExpiryId++, body);
      state.expiry.push(row);
      return json(route, { success: true, data: row }, 201);
    }

    // ---- /api/documents ----
    if (pathname === '/api/documents/expiring' && method === 'GET') {
      const days = Number(url.searchParams.get('days') ?? '90') || 90;
      const limit = addDaysYmd(today, days);
      const rows = state.documents.filter(
        (row) => row.is_active && row.expires_at != null && row.expires_at >= today && row.expires_at <= limit,
      );
      return json(route, { success: true, data: rows, days });
    }
    const numberMatch = /^\/api\/documents\/(\d+)\/number$/.exec(pathname);
    if (numberMatch && method === 'GET') {
      const id = Number(numberMatch[1]);
      const row = state.documents.find((candidate) => candidate.id === id);
      if (!row) return json(route, { success: false, error: '证件不存在' }, 404);
      if (!row.numberConfigured) return json(route, { success: false, error: '该证件未配置号码' }, 404);
      return json(route, { success: true, data: { number: state.numbers.get(id) ?? '' } });
    }
    const docMatch = /^\/api\/documents\/(\d+)$/.exec(pathname);
    if (docMatch) {
      const id = Number(docMatch[1]);
      const row = state.documents.find((candidate) => candidate.id === id);
      if (method === 'DELETE') {
        state.documents = state.documents.filter((candidate) => candidate.id !== id);
        return json(route, { success: true });
      }
      if (method === 'PATCH') {
        if (!row) return json(route, { success: false, error: '证件不存在' }, 404);
        const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
        if (typeof body.title === 'string') row.title = body.title;
        if (body.reminderConfig !== undefined) row.reminder_config = body.reminderConfig as Record<string, unknown> | null;
        if (body.documentNumber != null && String(body.documentNumber).trim()) row.numberConfigured = true;
        row.updated_at = new Date().toISOString();
        return json(route, { success: true, data: row });
      }
      if (method === 'GET') {
        return row
          ? json(route, { success: true, data: row })
          : json(route, { success: false, error: '证件不存在' }, 404);
      }
    }
    if (pathname === '/api/documents' && method === 'GET') {
      const kind = url.searchParams.get('kind');
      const active = url.searchParams.get('active');
      const q = url.searchParams.get('q');
      let list = state.documents.slice();
      if (kind) list = list.filter((row) => row.kind === kind);
      if (active === 'true') list = list.filter((row) => row.is_active);
      if (active === 'false') list = list.filter((row) => !row.is_active);
      if (q) {
        const needle = q.toLowerCase();
        list = list.filter((row) => `${row.title} ${row.issuer ?? ''}`.toLowerCase().includes(needle));
      }
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 200, total: list.length, totalPages: 1 } });
    }
    if (pathname === '/api/documents' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const id = nextDocId++;
      const nowIso = new Date().toISOString();
      const row: DocRow = {
        id,
        user_id: 1,
        profile_id: null,
        kind: String(body.kind ?? 'other'),
        title: String(body.title ?? ''),
        issuer: body.issuer == null ? null : String(body.issuer),
        issued_at: typeof body.issuedAt === 'string' ? body.issuedAt : null,
        expires_at: typeof body.expiresAt === 'string' ? body.expiresAt : null,
        country: body.country == null ? null : String(body.country),
        notes: body.notes == null ? null : String(body.notes),
        reminder_config: (body.reminderConfig ?? null) as Record<string, unknown> | null,
        is_active: body.isActive !== false,
        created_at: nowIso,
        updated_at: nowIso,
        numberConfigured: body.documentNumber != null && String(body.documentNumber).length > 0,
      };
      state.documents.push(row);
      if (row.numberConfigured) state.numbers.set(id, String(body.documentNumber));
      return json(route, { success: true, data: row }, 201);
    }

    // ---- /api/attachments ----
    if (pathname === '/api/attachments' && method === 'GET') {
      const ownerType = url.searchParams.get('owner_type');
      const ownerId = url.searchParams.get('owner_id');
      let list = state.attachments.slice();
      if (ownerType) list = list.filter((row) => row.owner_type === ownerType);
      if (ownerId) list = list.filter((row) => row.owner_id === Number(ownerId));
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 200, total: list.length, totalPages: 1 } });
    }
    if (pathname === '/api/attachments' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const raw = Buffer.from(String(body.dataBase64 ?? ''), 'base64');
      if (raw.byteLength === 0) return json(route, { success: false, error: '不能上传空文件' }, 400);
      const id = nextAttachmentId++;
      const row: AttachmentRow = {
        id,
        owner_type: String(body.ownerType ?? 'document'),
        owner_id: Number(body.ownerId),
        filename: String(body.filename ?? ''),
        content_type: String(body.contentType ?? ''),
        byte_size: raw.byteLength,
        sha256: '0'.repeat(64),
        created_at: new Date().toISOString(),
        download_url: `/api/attachments/${id}`,
      };
      state.attachments.push(row);
      return json(route, { success: true, data: row }, 201);
    }
    const attachmentMatch = /^\/api\/attachments\/(\d+)$/.exec(pathname);
    if (attachmentMatch && method === 'DELETE') {
      const id = Number(attachmentMatch[1]);
      state.attachments = state.attachments.filter((row) => row.id !== id);
      return json(route, { success: true });
    }

    // ---- /api/inventory ----
    if (pathname === '/api/inventory/low-stock' && method === 'GET') {
      const rows = state.inventory.filter(
        (row) => row.is_active && row.low_stock_threshold != null && row.quantity <= row.low_stock_threshold,
      );
      return json(route, { success: true, data: rows });
    }
    if (pathname === '/api/inventory/expiring' && method === 'GET') {
      const days = Number(url.searchParams.get('days') ?? '30') || 30;
      const limit = addDaysYmd(today, days);
      const rows = state.inventory.filter(
        (row) => row.is_active && row.expires_at != null && row.expires_at <= limit,
      );
      return json(route, { success: true, data: rows, days });
    }
    const invMatch = /^\/api\/inventory\/(\d+)$/.exec(pathname);
    if (invMatch && method === 'PATCH') {
      const id = Number(invMatch[1]);
      const row = state.inventory.find((candidate) => candidate.id === id);
      if (!row) return json(route, { success: false, error: '库存项不存在' }, 404);
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      if (body.reminderConfig !== undefined) row.reminder_config = body.reminderConfig as Record<string, unknown> | null;
      row.updated_at = new Date().toISOString();
      return json(route, { success: true, data: row });
    }
    if (pathname === '/api/inventory' && method === 'GET') {
      const category = url.searchParams.get('category');
      const lowStock = url.searchParams.get('lowStock');
      const q = url.searchParams.get('q');
      let list = state.inventory.slice();
      if (category) list = list.filter((row) => row.category === category);
      if (lowStock === 'true') {
        list = list.filter((row) => row.low_stock_threshold != null && row.quantity <= row.low_stock_threshold);
      }
      if (q) {
        const needle = q.toLowerCase();
        list = list.filter((row) => `${row.name} ${row.location ?? ''}`.toLowerCase().includes(needle));
      }
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 200, total: list.length, totalPages: 1 } });
    }
    if (pathname === '/api/inventory' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const nowIso = new Date().toISOString();
      const row: InvRow = {
        id: nextInvId++,
        user_id: 1,
        profile_id: null,
        name: String(body.name ?? ''),
        category: String(body.category ?? 'other'),
        quantity: typeof body.quantity === 'number' ? body.quantity : 1,
        unit: body.unit == null || body.unit === '' ? null : String(body.unit),
        low_stock_threshold: typeof body.lowStockThreshold === 'number' ? body.lowStockThreshold : null,
        purchased_at: typeof body.purchasedAt === 'string' ? body.purchasedAt : null,
        expires_at: typeof body.expiresAt === 'string' ? body.expiresAt : null,
        location: body.location == null ? null : String(body.location),
        notes: body.notes == null ? null : String(body.notes),
        reminder_config: (body.reminderConfig ?? null) as Record<string, unknown> | null,
        is_active: body.isActive !== false,
        created_at: nowIso,
        updated_at: nowIso,
      };
      state.inventory.push(row);
      return json(route, { success: true, data: row }, 201);
    }

    // ---- /api/maintenance ----
    const planMatch = /^\/api\/maintenance\/(\d+)$/.exec(pathname);
    if (planMatch && method === 'PATCH') {
      const id = Number(planMatch[1]);
      const plan = state.plans.find((candidate) => candidate.id === id);
      if (!plan) return json(route, { success: false, error: '保养计划不存在' }, 404);
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      if (body.reminderConfig !== undefined) plan.reminder_config = body.reminderConfig as Record<string, unknown> | null;
      if (typeof body.nextDueUsage === 'number') plan.next_due_usage = body.nextDueUsage;
      if (typeof body.currentUsage === 'number') plan.current_usage = body.currentUsage;
      plan.updated_at = new Date().toISOString();
      return json(route, { success: true, data: plan });
    }
    if (pathname === '/api/maintenance' && method === 'GET') {
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
    if (pathname === '/api/maintenance' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const nowIso = new Date().toISOString();
      const row: PlanRow = {
        id: nextPlanId++,
        user_id: 1,
        profile_id: null,
        asset_name: String(body.assetName ?? ''),
        asset_kind: String(body.assetKind ?? 'other'),
        interval_days: typeof body.intervalDays === 'number' ? body.intervalDays : null,
        interval_usage: typeof body.intervalUsage === 'number' ? body.intervalUsage : null,
        usage_unit: body.usageUnit == null || body.usageUnit === '' ? null : String(body.usageUnit),
        current_usage: typeof body.currentUsage === 'number' ? body.currentUsage : null,
        last_done_at: typeof body.lastDoneAt === 'string' ? body.lastDoneAt : null,
        next_due_at: typeof body.nextDueAt === 'string' ? body.nextDueAt : null,
        next_due_usage: typeof body.nextDueUsage === 'number' ? body.nextDueUsage : null,
        notes: body.notes == null ? null : String(body.notes),
        reminder_config: (body.reminderConfig ?? null) as Record<string, unknown> | null,
        is_active: body.isActive !== false,
        created_at: nowIso,
        updated_at: nowIso,
      };
      state.plans.push(row);
      return json(route, { success: true, data: row }, 201);
    }

    // ---- /api/inbox ----
    if (pathname === '/api/inbox' && method === 'GET') {
      const list = state.inbox.slice().sort((a, b) => b.id - a.id);
      return json(route, {
        success: true,
        data: list,
        pagination: { page: 1, limit: 100, total: list.length, totalPages: 1, unreadCount: list.filter((m) => !m.is_read).length },
      });
    }
    const inboxMatch = /^\/api\/inbox\/(\d+)\/read$/.exec(pathname);
    if (inboxMatch && method === 'PATCH') {
      const message = state.inbox.find((candidate) => candidate.id === Number(inboxMatch[1]));
      if (message) message.is_read = true;
      return json(route, { success: true });
    }
    if (pathname === '/api/inbox/read-all' && method === 'POST') {
      for (const message of state.inbox) message.is_read = true;
      return json(route, { success: true });
    }

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return state;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ApiCallResult {
  status: number;
  body: { success?: boolean; data?: unknown; error?: string };
}

async function apiFetch(
  page: Page,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiCallResult> {
  return page.evaluate(
    async (arg: { url: string; method: string; body: string | null }) => {
      const res = await fetch(`http://localhost:3000${arg.url}`, {
        method: arg.method,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: arg.body,
      });
      return { status: res.status, body: (await res.json()) as { success?: boolean; data?: unknown; error?: string } };
    },
    { url, method: init.method ?? 'GET', body: init.body === undefined ? null : JSON.stringify(init.body) },
  );
}

/** UI 没有 reminder_config 编辑入口；真实 API 接受 reminderConfig（create/update schema）。 */
async function patchReminderConfig(
  page: Page,
  resource: 'expiry' | 'documents' | 'inventory' | 'maintenance',
  id: number,
  daysBeforeList: number[],
): Promise<void> {
  const res = await apiFetch(page, `/api/${resource}/${id}`, {
    method: 'PATCH',
    body: { reminderConfig: { daysBeforeList, reminderTimes: ['09:00'], channels: ['generic_webhook'] } },
  });
  expect(res.status, `${resource} #${id} reminderConfig PATCH should succeed`).toBe(200);
}

async function runCheck(page: Page, at: Date): Promise<ReminderCheckResult> {
  const res = await apiFetch(page, `/api/cron/reminder-check?at=${encodeURIComponent(at.toISOString())}`);
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  if (!res.body.data) throw new Error('reminder-check returned no data');
  return res.body.data as ReminderCheckResult;
}

/**
 * 打开「新建 X」对话框：等上一个对话框完全关闭（否则 aria-labelledby 会让
 * getByLabel('新建 X') 同时命中按钮与对话框），再点页头按钮。
 */
async function openCreate(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // 空状态区可能还有一个同名按钮（如到期中心），页头按钮在 DOM 中排第一。
  await page.getByRole('button', { name }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/** 保存并等待对话框卸载（保存请求完成前对话框仍开着）。 */
async function saveAndClose(page: Page, name: string): Promise<void> {
  await page.getByLabel(name).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

function writeEvidence(fileName: string, payload: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, `${fileName}${EVIDENCE_SUFFIX}`), JSON.stringify(payload, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('life-domain smoke: clean state -> expiry/document+attachment/inventory/maintenance -> queries -> Inbox', async ({ page }) => {
  test.setTimeout(120_000);
  const state = await setup(page);
  const today = shanghaiYmd(new Date());
  const expiringDue = addDaysYmd(today, 7);
  const overdueDue = addDaysYmd(today, -10);
  const passportDue = addDaysYmd(today, 180);
  const certificateDue = addDaysYmd(today, 90);
  const milkDue = addDaysYmd(today, 7);
  const maintenanceDue = addDaysYmd(today, 3);
  const checkNow = new Date(`${today}T09:00:30+08:00`);

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  // ===== 1. 到期项（临期 + 已逾期）=====
  await page.goto('/expiry');
  await expect(page.getByRole('heading', { name: '到期中心' })).toBeVisible();

  await openCreate(page, '新建到期项');
  await page.getByLabel('名称', { exact: true }).fill('云盘会员');
  await page.getByLabel('类型', { exact: true }).selectOption('subscription');
  await page.getByLabel('续费周期', { exact: true }).selectOption('monthly');
  await page.getByLabel('下次到期日', { exact: true }).fill(expiringDue);
  await page.getByLabel('金额', { exact: true }).fill('19.99');
  await saveAndClose(page, '保存到期项');

  await openCreate(page, '新建到期项');
  await page.getByLabel('名称', { exact: true }).fill('过期视频会员');
  await page.getByLabel('类型', { exact: true }).selectOption('subscription');
  await page.getByLabel('续费周期', { exact: true }).selectOption('once');
  await page.getByLabel('下次到期日', { exact: true }).fill(overdueDue);
  await saveAndClose(page, '保存到期项');

  const expiringItem = state.expiry.find((row) => row.title === '云盘会员');
  const overdueItem = state.expiry.find((row) => row.title === '过期视频会员');
  expect(expiringItem, 'expiring item created through the UI').toBeTruthy();
  expect(overdueItem, 'overdue item created through the UI').toBeTruthy();

  await expect(page.getByTestId(`expiry-item-${expiringItem!.id}`)).toBeVisible();
  await expect(page.getByTestId(`expiry-countdown-${expiringItem!.id}`)).toContainText('还有');
  await expect(page.getByTestId(`expiry-due-${expiringItem!.id}`)).toHaveText(expiringDue);

  const overdueBucket = page.getByTestId('expiry-bucket-overdue');
  await expect(overdueBucket).toBeVisible();
  await expect(overdueBucket.getByTestId(`expiry-item-${overdueItem!.id}`)).toBeVisible();
  await expect(page.getByTestId(`expiry-overdue-badge-${overdueItem!.id}`)).toBeVisible();
  await expect(page.getByTestId('expiry-summary-overdue')).toHaveAttribute('data-count', '1');
  await expect(page.locator('body')).not.toContainText('NaN');

  // 页面自身调用 GET /api/expiry/overdue（overdue 权威计数）。
  expect(state.requests).toContain('GET /api/expiry/overdue');
  const overdueQuery = await apiFetch(page, '/api/expiry/overdue');
  expect(overdueQuery.status).toBe(200);
  const overdueRows = overdueQuery.body.data as Array<{ title: string }>;
  expect(overdueRows.map((row) => row.title)).toEqual(['过期视频会员']);

  // 直接契约断言：GET /api/expiry/upcoming?days=30 形状 + 数据。
  const upcomingQuery = await apiFetch(page, '/api/expiry/upcoming?days=30');
  expect(upcomingQuery.status).toBe(200);
  const upcomingBody = upcomingQuery.body as { success: boolean; days: number; data: Array<{ id: number; title: string; next_due_date: string }> };
  expect(upcomingBody.success).toBe(true);
  expect(upcomingBody.days).toBe(30);
  expect(upcomingBody.data.map((row) => row.title)).toEqual(['云盘会员']);
  expect(upcomingBody.data[0]?.next_due_date).toBe(expiringDue);

  await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-59-expiry${EVIDENCE_SUFFIX}.png`), fullPage: true });

  // ===== 2. 证件 + 附件 =====
  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: '证件保险箱' })).toBeVisible();

  // 护照：带号码（掩码断言）+ 到期日（180 天，passport 长提前集）
  await openCreate(page, '新建证件');
  await page.getByLabel('名称', { exact: true }).fill('中国护照');
  await page.getByLabel('类型', { exact: true }).selectOption('passport');
  await page.getByLabel('签发机构', { exact: true }).fill('NIA');
  await page.getByLabel('证件号码', { exact: true }).fill('E12345678');
  await page.getByLabel('到期日', { exact: true }).fill(passportDue);
  await saveAndClose(page, '保存证件');

  // 在职证明：null 可选字段（无号码/签发机构/备注），到期日 90 天（短提前集）
  await openCreate(page, '新建证件');
  await page.getByLabel('名称', { exact: true }).fill('在职证明');
  await page.getByLabel('类型', { exact: true }).selectOption('certificate');
  await page.getByLabel('到期日', { exact: true }).fill(certificateDue);
  await saveAndClose(page, '保存证件');

  const passport = state.documents.find((row) => row.title === '中国护照');
  const certificate = state.documents.find((row) => row.title === '在职证明');
  expect(passport?.numberConfigured).toBe(true);
  expect(certificate?.issuer).toBeNull();
  expect(certificate?.expires_at).toBe(certificateDue);

  await expect(page.getByTestId(`document-number-${passport!.id}`)).toHaveText('•••• •••• ••••');
  await expect(page.getByTestId(`document-number-${passport!.id}`)).toHaveAttribute('data-masked', 'true');
  await expect(page.getByTestId(`document-countdown-${certificate!.id}`)).toContainText('还有');
  await expect(page.locator('body')).not.toContainText('NaN');

  // 附件：先保存证件，再在编辑对话框上传（真实 UI 契约）。
  await page.getByLabel('编辑 中国护照').click();
  await page.getByTestId('document-attachment-input').setInputFiles(path.join(FIXTURES_DIR, 'sample.pdf'));
  await expect(page.getByTestId('attachment-upload-list')).toContainText('sample.pdf');
  expect(state.attachments).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`document-attachments-${passport!.id}`)).toContainText('sample.pdf');

  // GET /api/documents/expiring?days=90（页面汇总调用；90 天内的在职证明）
  expect(state.requests.some((entry) => entry.startsWith('GET /api/documents/expiring?days=90'))).toBe(true);
  await expect(page.getByTestId('documents-summary-expiring')).toHaveAttribute('data-count', '1');

  await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-59-documents${EVIDENCE_SUFFIX}.png`), fullPage: true });

  // ===== 3. 库存（低库存 + 临期；无保质期 null 字段）=====
  await page.goto('/inventory');
  await expect(page.getByRole('heading', { name: '库存' })).toBeVisible();

  await openCreate(page, '新建库存项');
  await page.getByLabel('名称', { exact: true }).fill('牛奶');
  await page.getByLabel('分类', { exact: true }).selectOption('food');
  await page.getByLabel('数量', { exact: true }).fill('2');
  await page.getByLabel('低库存阈值', { exact: true }).fill('2');
  await page.getByLabel('单位', { exact: true }).fill('盒');
  await page.getByLabel('到期日', { exact: true }).fill(milkDue);
  await saveAndClose(page, '保存库存项');

  await openCreate(page, '新建库存项');
  await page.getByLabel('名称', { exact: true }).fill('纸巾');
  await page.getByLabel('分类', { exact: true }).selectOption('other');
  await page.getByLabel('数量', { exact: true }).fill('0');
  await saveAndClose(page, '保存库存项');

  const milk = state.inventory.find((row) => row.name === '牛奶');
  const tissues = state.inventory.find((row) => row.name === '纸巾');
  expect(milk?.expires_at).toBe(milkDue);
  expect(tissues?.expires_at).toBeNull();
  expect(tissues?.unit).toBeNull();

  await expect(page.getByTestId(`inventory-item-${milk!.id}`)).toBeVisible();
  await expect(page.getByTestId(`inventory-qty-${milk!.id}`)).toHaveText('2 盒');
  await expect(page.getByTestId(`inventory-low-stock-badge-${milk!.id}`)).toBeVisible();
  await expect(page.getByTestId(`inventory-expiry-${milk!.id}`)).toContainText('还有');
  await expect(page.getByTestId(`inventory-expiry-${tissues!.id}`)).toHaveText('无保质期');
  await expect(page.getByTestId('inventory-summary-low')).toHaveAttribute('data-count', '1');
  await expect(page.getByTestId('inventory-summary-expiring')).toHaveAttribute('data-count', '1');
  await expect(page.locator('body')).not.toContainText('NaN');

  // 页面自身调用 GET /api/inventory/low-stock（汇总）。
  expect(state.requests).toContain('GET /api/inventory/low-stock');
  const lowStockQuery = await apiFetch(page, '/api/inventory/low-stock');
  expect(lowStockQuery.status).toBe(200);
  expect((lowStockQuery.body.data as Array<{ name: string }>).map((row) => row.name)).toEqual(['牛奶']);

  await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-59-inventory${EVIDENCE_SUFFIX}.png`), fullPage: true });

  // ===== 4. 保养计划（日期 + 用量）=====
  await page.goto('/maintenance');
  await expect(page.getByRole('heading', { name: '保养' })).toBeVisible();

  await openCreate(page, '新建保养计划');
  await page.getByLabel('资产名称', { exact: true }).fill('家用轿车');
  await page.getByLabel('资产类型', { exact: true }).selectOption('vehicle');
  await page.getByLabel('按日期间隔（天）', { exact: true }).fill('180');
  await page.getByLabel('按用量间隔', { exact: true }).fill('10000');
  await page.getByLabel('用量单位', { exact: true }).selectOption('km');
  await page.getByLabel('当前用量', { exact: true }).fill('43000');
  // next_due_usage 现在是 UI 字段（wave7d-59 issue 2：用量提醒条件必须可达）：
  // next_due_usage - current_usage (500) <= interval_usage * 0.1 (1000)。
  await page.getByLabel('下次保养用量', { exact: true }).fill('43500');
  await page.getByLabel('上次保养日期', { exact: true }).fill(today);
  await page.getByLabel('下次保养日期', { exact: true }).fill(maintenanceDue);
  await saveAndClose(page, '保存保养计划');

  const car = state.plans.find((row) => row.asset_name === '家用轿车');
  expect(car, 'maintenance plan created through the UI').toBeTruthy();
  expect(car?.next_due_usage, 'next_due_usage is reachable through the UI form').toBe(43500);
  await expect(page.getByTestId(`maintenance-card-${car!.id}`)).toBeVisible();
  await expect(page.getByTestId(`maintenance-next-due-${car!.id}`)).toHaveText(maintenanceDue);
  await expect(page.locator('body')).not.toContainText('NaN');

  await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-59-maintenance${EVIDENCE_SUFFIX}.png`), fullPage: true });

  // ===== 5. 提醒引擎：四个领域各派发一次；已逾期项不派发 =====
  for (const [resource, id, days] of [
    ['expiry', expiringItem!.id, [30, 7, 3, 1, 0]],
    ['documents', passport!.id, [180, 90, 30, 7, 0]],
    ['documents', certificate!.id, [90, 30, 7, 0]],
    ['inventory', milk!.id, [30, 7, 3, 1, 0]],
    ['maintenance', car!.id, [30, 7, 3, 1, 0]],
  ] as const) {
    await patchReminderConfig(page, resource, id, [...days]);
  }

  const check = await runCheck(page, checkNow);
  expect(check.dated.expiry.dispatched.map((entry) => entry.title)).toEqual(['云盘会员']);
  expect(check.dated.expiry.sent).toBe(1);
  expect(check.dated.document.dispatched.map((entry) => entry.title).sort()).toEqual(['中国护照', '在职证明']);
  expect(check.dated.document.sent).toBe(2);
  expect(check.dated.inventory.dispatched.map((entry) => entry.title)).toEqual(['牛奶']);
  expect(check.dated.inventory.sent).toBe(1);
  expect(check.dated.maintenance.dispatched.map((entry) => entry.title)).toEqual(['家用轿车']);
  expect(check.dated.maintenance.sent).toBe(1);
  expect(check.usage.nudged).toBe(1);
  // 已逾期（过去日期）绝不进入「即将到来」派发（按 source 区分，避免跨表 id 碰撞）。
  expect(state.dispatches.some((entry) => entry.source === 'expiry' && entry.id === overdueItem!.id)).toBe(false);

  writeEvidence('task-59-reminder-check.json', {
    at: check.at,
    dated: check.dated,
    usage: check.usage,
    claims: [...state.claims].sort(),
  });

  // ===== 6. 收件箱：用量提醒以 source='inbound' 出现 =====
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: '收件箱' })).toBeVisible();
  await expect(page.getByText('保养提醒：家用轿车')).toBeVisible();
  await expect(page.getByText('剩余 500km')).toBeVisible();
  await expect(page.getByText('外部推送').first()).toBeVisible();
  await expect(page.getByText('共 1 条消息')).toBeVisible();
  expect(state.inbox).toHaveLength(1);

  await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-59-inbox${EVIDENCE_SUFFIX}.png`), fullPage: true });
});

test('reminder absence: a deleted expiry item never fires while its surviving twin does', async ({ page }) => {
  test.setTimeout(120_000);
  const state = await setup(page);
  const today = shanghaiYmd(new Date());
  const due = addDaysYmd(today, 7);
  const checkNow = new Date(`${today}T09:00:30+08:00`);

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/expiry');
  await expect(page.getByRole('heading', { name: '到期中心' })).toBeVisible();

  for (const title of ['保留到期项', '删除到期项']) {
    await openCreate(page, '新建到期项');
    await page.getByLabel('名称', { exact: true }).fill(title);
    await page.getByLabel('类型', { exact: true }).selectOption('subscription');
    await page.getByLabel('续费周期', { exact: true }).selectOption('monthly');
    await page.getByLabel('下次到期日', { exact: true }).fill(due);
    await saveAndClose(page, '保存到期项');
  }

  const survivor = state.expiry.find((row) => row.title === '保留到期项');
  const doomed = state.expiry.find((row) => row.title === '删除到期项');
  expect(survivor, 'survivor created').toBeTruthy();
  expect(doomed, 'doomed twin created').toBeTruthy();
  expect(survivor!.next_due_date).toBe(doomed!.next_due_date);

  // 两条完全相同的提醒配置（同一窗口、同一提前天数）——删除必须是唯一变量。
  await patchReminderConfig(page, 'expiry', survivor!.id, [30, 7, 3, 1, 0]);
  await patchReminderConfig(page, 'expiry', doomed!.id, [30, 7, 3, 1, 0]);
  // 前置：干净状态下尚未有任何人发过提醒（absence 不能由去重解释）。
  expect(state.claims.size).toBe(0);
  expect(state.dispatches).toHaveLength(0);

  // 流程中途删除该到期项。
  await page.getByLabel('删除 删除到期项').click();
  await expect(page.getByRole('status').filter({ hasText: '已删除「删除到期项」' })).toBeVisible();
  await expect(page.getByTestId(`expiry-item-${doomed!.id}`)).toHaveCount(0);
  // 读取路径（列表/upcoming/overdue）不再可见。
  expect(visibleExpiry(state).some((row) => row.id === doomed!.id)).toBe(false);

  // 触发提醒检查（真实引擎语义的 mock mirror；同一时刻、同一窗口）。
  const check = await runCheck(page, checkNow);
  const expiryStats = check.dated.expiry;

  // presence control：存活孪生项照常发射（证明该断言能看见「发射」）。
  expect(expiryStats.dispatched.map((entry) => entry.id)).toEqual([survivor!.id]);
  expect(expiryStats.sent).toBe(1);
  expect(expiryStats.claimed).toBe(1);
  // ABSENCE：被删除项既不派发、也不写 claim（不是被去重掩盖）。
  expect(expiryStats.dispatched.some((entry) => entry.id === doomed!.id)).toBe(false);
  expect([...state.claims].some((claim) => claim.startsWith(`${doomed!.id}#`))).toBe(false);
  expect(state.dispatches.some((entry) => entry.id === doomed!.id)).toBe(false);

  writeEvidence('task-59-reminder-absence.json', {
    at: check.at,
    survivor: { id: survivor!.id, title: survivor!.title },
    doomed: { id: doomed!.id, title: doomed!.title },
    expiry: expiryStats,
    usage: check.usage,
    claims: [...state.claims].sort(),
  });

  await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-59-reminder-after-delete${EVIDENCE_SUFFIX}.png`), fullPage: true });
});

/**
 * wave7d-59 issue 2：UI 创建路径不写 reminder_config。修复前 reminder-channel-resolver
 * 在无条目渠道 / 无条件规则 / 无套餐时返回 []，迭代器把条目当作「无渠道」跳过 —— 用户在
 * 全新安装上完全收不到提醒。修复后回退到用户已启用渠道（notification_accounts）。
 *
 * 本用例只走 UI + 同一 mock 引擎：创建 → 断言 reminder_config 确实为 null → 在窗口内
 * 触发提醒检查 → 断言派发发生且写入 claim（不是被跳过）。
 */
test('no-config dispatch: a UI-created item with no reminder_config fires through the default active channels', async ({ page }) => {
  test.setTimeout(120_000);
  const state = await setup(page);
  const today = shanghaiYmd(new Date());
  const due = addDaysYmd(today, 7);
  const checkNow = new Date(`${today}T09:00:30+08:00`);

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  await page.goto('/expiry');
  await expect(page.getByRole('heading', { name: '到期中心' })).toBeVisible();

  await openCreate(page, '新建到期项');
  await page.getByLabel('名称', { exact: true }).fill('无配置订阅');
  await page.getByLabel('类型', { exact: true }).selectOption('subscription');
  await page.getByLabel('续费周期', { exact: true }).selectOption('monthly');
  await page.getByLabel('下次到期日', { exact: true }).fill(due);
  await saveAndClose(page, '保存到期项');

  const item = state.expiry.find((row) => row.title === '无配置订阅');
  expect(item, 'item created through the UI').toBeTruthy();
  // 前置条件（修复的靶点）：UI 路径没有写 reminder_config。
  expect(item!.reminder_config).toBeNull();
  // 用户已经配置了至少一个启用渠道（否则提醒本来就无处可送）。
  expect(state.defaultChannels.length).toBeGreaterThan(0);

  const check = await runCheck(page, checkNow);
  const expiryStats = check.dated.expiry;

  expect(expiryStats.dispatched.map((entry) => entry.title)).toEqual(['无配置订阅']);
  expect(expiryStats.sent).toBe(1);
  expect(expiryStats.claimed).toBe(1);
  // claim 写入 = 真的走完了「解析渠道 → 派发」路径，而不是被跳过。
  expect([...state.claims]).toContain(`${item!.id}#expiry:${today}#d7#t09:00`);

  writeEvidence('task-59-fix-no-config-dispatch.json', {
    at: check.at,
    reminderConfig: item!.reminder_config,
    defaultChannels: state.defaultChannels,
    expiry: expiryStats,
    claims: [...state.claims].sort(),
  });

  await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-59-fix-no-config${EVIDENCE_SUFFIX}.png`), fullPage: true });
});
