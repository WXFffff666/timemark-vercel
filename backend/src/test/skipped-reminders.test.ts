import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 165 (wave 19): a reminder slot that resolves NO channel must never be dropped
 * silently. Both the main event path (`sendReminders`, tasks.ts:1581) and the dated iterator
 * (`sendExpiryReminders`) now write a `skipped` trigger row carrying the machine-readable
 * reason `no_channel_resolved`, deduped with the SAME `reminder_send_claims` claim a send
 * uses - so two minute-ticks inside one slot write exactly ONE row and log exactly once.
 *
 * The date is 2026-06-08 09:00 Asia/Shanghai (NOW_STATE = 01:00Z); the event / expiry item is
 * due exactly 7 days later with a 09:00 reminder time, i.e. inside the ±2-minute window.
 *
 * These tests drive the REAL `sendReminders` / `sendExpiryReminders` / `recordEventTrigger`
 * over an SQL-aware in-memory store (same approach as trigger-log-persistence.test.ts).
 */

const mocks = vi.hoisted(() => {
  const logs = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const makeLogger = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'child') return makeLogger;
          if (prop in logs) return logs[prop as keyof typeof logs];
          return () => undefined;
        },
      },
    );
  return {
    query: vi.fn(),
    logs,
    makeLogger,
    NOW_STATE: { value: new Date('2026-06-08T01:00:00Z') }, // 09:00 Asia/Shanghai
    getUserConfig: vi.fn(),
    getRelationshipMappings: vi.fn(),
    getNotificationAccounts: vi.fn(),
    getEventTemplate: vi.fn(),
  };
});

vi.mock('../db/index.js', () => ({
  query: mocks.query,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => mocks.makeLogger(),
  createLoggerInstance: () => mocks.makeLogger(),
  logger: mocks.makeLogger(),
  logFireAndForget: () => () => undefined,
  runWithRequestLog: (_context: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../utils/ntp.js', () => ({
  getSyncedNow: () => mocks.NOW_STATE.value,
  scheduleTimeSync: vi.fn(),
  DEFAULT_SYNC_TIMEZONE: 'Asia/Shanghai',
}));

vi.mock('../services/config.service.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getUserConfig: mocks.getUserConfig,
    getRelationshipMappings: mocks.getRelationshipMappings,
    getNotificationAccounts: mocks.getNotificationAccounts,
    getEventTemplate: mocks.getEventTemplate,
  };
});

vi.mock('../services/conflict-hint.service.js', () => ({
  getConflictHint: vi.fn(async () => null),
}));

import { sendReminders, sendExpiryReminders } from '../jobs/tasks.js';

interface Captured {
  sql: string;
  params: unknown[];
}

interface StoredLogRow {
  id: number;
  event_id: unknown;
  user_id: unknown;
  trigger_type: unknown;
  trigger_date: unknown;
  status: unknown;
  error_message: unknown;
}

interface StoredAccount {
  id: number;
  type: string;
  name: string;
  is_active: boolean;
  webhook: string | null;
  token: string | null;
  secret: string | null;
  chat_id: string | null;
}

interface Store {
  logs: StoredLogRow[];
  logInserts: Captured[];
  claims: Set<string>;
  accounts: StoredAccount[];
  failLogInsert: boolean;
}

const ACCOUNT_ID = 77;

const ACCOUNT: StoredAccount = {
  id: ACCOUNT_ID,
  type: 'email',
  name: 'owner@example.com',
  is_active: true,
  webhook: null,
  token: null, // config resolves, dispatch fails deterministically (no network)
  secret: null,
  chat_id: 'owner@example.com',
};

/** A due event whose normal window is 09:00 Asia/Shanghai on the fixture day. */
function eventWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 501,
    user_id: 1,
    name: '早会',
    type: 'other',
    date: '2026-06-08',
    calendar_type: 'gregorian',
    lunar_date: null,
    reminder_config: { enabled: true, daysBeforeList: [0], reminderTimes: ['09:00'] },
    notification_channels: ['email'],
    notification_account_ids: [ACCOUNT_ID],
    reminder_days_before: null,
    reminder_time: '09:00',
    profile_id: null,
    ...overrides,
  };
}

/** An expiry item due in 7 days, reminder at 09:00; `channels: []` exercises the fallback. */
function expiryItem(): Record<string, unknown> {
  return {
    id: 11,
    user_id: 1,
    profile_id: null,
    kind: 'subscription',
    title: 'Netflix 会员',
    next_due_date: '2026-06-08',
    reminder_config: { daysBeforeList: [7], reminderTimes: ['09:00'], channels: [] },
    is_active: true,
    timezone: 'Asia/Shanghai',
    reminders_enabled: true,
    holiday_reminder_mode: 'keep',
  };
}

let store: Store;

function installStore(options: {
  accounts?: StoredAccount[];
  event?: Record<string, unknown> | null;
  expiryItems?: Record<string, unknown>[];
  rules?: Array<{ days_before: number; channels: unknown }>;
  preset?: string | null;
  failLogInsert?: boolean;
} = {}): void {
  const event = options.event === undefined ? eventWith() : options.event;
  const expiryItems = options.expiryItems ?? [];
  const rules = options.rules ?? [];
  const preset = options.preset ?? null;

  store = {
    logs: [],
    logInserts: [],
    claims: new Set<string>(),
    accounts: options.accounts ?? [],
    failLogInsert: options.failLogInsert ?? false,
  };

  mocks.getUserConfig.mockResolvedValue({ timezone: 'Asia/Shanghai' });
  mocks.getRelationshipMappings.mockResolvedValue([]);
  mocks.getNotificationAccounts.mockImplementation(async () => store.accounts);
  mocks.getEventTemplate.mockResolvedValue(null);

  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO event_trigger_logs')) {
      if (store.failLogInsert) throw new Error('simulated: insert into event_trigger_logs failed');
      store.logInserts.push({ sql: s, params });
      store.logs.push({
        id: store.logs.length + 1,
        event_id: params[0],
        user_id: params[1],
        trigger_type: params[2],
        trigger_date: params[3],
        status: params[4],
        error_message: params[5],
      });
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('INSERT INTO reminder_send_claims')) {
      const key = `${String(params[0])}#${String(params[1])}`;
      if (store.claims.has(key)) return { rows: [], rowCount: 0 };
      store.claims.add(key);
      return { rows: [{ event_id: params[0] }], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM reminder_send_claims')) {
      store.claims.delete(`${String(params[0])}#${String(params[1])}`);
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('SELECT id FROM event_trigger_logs')) {
      const rows = store.logs
        .filter((row) => row.event_id === params[0] && row.trigger_date === params[1] && row.status === 'success')
        .map((row) => ({ id: row.id }));
      return { rows, rowCount: rows.length };
    }

    // 渠道解析优先级（未改动）：条件规则 > 套餐分级 > 事件/条目渠道 > 已启用账户。
    if (s.includes('FROM conditional_reminder_rules')) {
      return { rows: rules, rowCount: rules.length };
    }
    if (s.includes('notification_preset FROM user_configs')) {
      return { rows: preset ? [{ notification_preset: preset }] : [], rowCount: preset ? 1 : 0 };
    }
    if (s.includes('FROM notification_accounts')) {
      const rows = store.accounts.map((account) => ({ type: account.type }));
      return { rows, rowCount: rows.length };
    }

    // 其余查询全是引擎的批次读取：只返回本 fixture 需要的行。
    if (s.includes('FROM user_configs')) {
      return {
        rows: [
          {
            user_id: 1,
            timezone: 'Asia/Shanghai',
            reminders_enabled: true,
            daily_check_time: null,
            days_before_list: [0],
            reminder_emails: [],
            holiday_reminder_mode: 'keep',
            notification_preset: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (s.includes('SELECT DISTINCT user_id FROM events')) return { rows: [{ user_id: 1 }], rowCount: 1 };
    if (s.includes('FROM profiles')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM event_reminder_cache')) {
      return event ? { rows: [{ user_id: 1, payload: [event] }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM events WHERE user_id')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM expiry_items')) return { rows: expiryItems, rowCount: expiryItems.length };
    return { rows: [], rowCount: 0 };
  });
}

function skippedInserts(): Captured[] {
  return store.logInserts.filter((insert) => insert.params[4] === 'skipped');
}

function skipInfoLogs(): unknown[][] {
  return mocks.logs.info.mock.calls.filter(([, message]) => message === 'Reminder skipped: no channel resolved');
}

beforeEach(() => {
  mocks.NOW_STATE.value = new Date('2026-06-08T01:00:00Z');
  mocks.logs.error.mockReset();
  mocks.logs.warn.mockReset();
  mocks.logs.info.mockReset();
  mocks.logs.debug.mockReset();
  installStore();
});

describe('main path - no channel resolved', () => {
  it('records one skipped row carrying no_channel_resolved when the user has zero active accounts', async () => {
    installStore({ accounts: [], event: eventWith({ notification_channels: [] }) });

    await sendReminders();

    const inserts = skippedInserts();
    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    expect(insert.params[0]).toBe(501);
    expect(insert.params[1]).toBe(1);
    expect(insert.params[2]).toBe('scheduled');
    expect(insert.params[3]).toBe('2026-06-08#d0#t09:00');
    expect(insert.params[4]).toBe('skipped');
    expect(insert.params[5]).toBe('no_channel_resolved');
    // Nothing was dispatched, so there is no success/failed row - only the skip record.
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0].status).toBe('skipped');
  });

  it('two ticks in the same slot write exactly ONE skipped row and log it exactly once', async () => {
    installStore({ accounts: [], event: eventWith({ notification_channels: [] }) });

    await sendReminders();
    await sendReminders();

    expect(skippedInserts()).toHaveLength(1);
    expect(skipInfoLogs()).toHaveLength(1);
    // The second tick took the claim short-circuit, not a second write.
    expect(
      mocks.logs.debug.mock.calls.some(([, message]) => message === 'Skipped reminder already recorded for this slot'),
    ).toBe(true);
  });

  it('surfaces a failed skip-record write instead of swallowing it, and never fails the run', async () => {
    installStore({ accounts: [], event: eventWith({ notification_channels: [] }), failLogInsert: true });

    await expect(sendReminders()).resolves.toBeUndefined();

    expect(store.logs).toHaveLength(0);
    const surfaced = mocks.logs.error.mock.calls.find(
      ([, message]) =>
        typeof message === 'string' && message.includes('skipped reminder not recorded in 提醒日志'),
    );
    expect(surfaced).toBeDefined();
  });
});

describe('main path - channels DO resolve (send path unchanged)', () => {
  it('keeps the send-path record (failed, email/77) and never a skipped row', async () => {
    installStore({ accounts: [{ ...ACCOUNT }] }); // event keeps its ['email'] item channel

    await sendReminders();

    expect(store.logInserts).toHaveLength(1);
    const [insert] = store.logInserts;
    expect(insert.params[3]).toBe('2026-06-08#d0#t09:00');
    expect(insert.params[4]).toBe('failed'); // token-less email account fails deterministically
    expect(insert.params[8]).toBe('email');
    expect(insert.params[9]).toBe(ACCOUNT_ID);
    expect(skippedInserts()).toHaveLength(0);

    // The send claim still dedups a second tick in the same slot.
    await sendReminders();
    expect(store.logInserts).toHaveLength(1);
  });

  it('priority untouched: a conditional rule resolves channels even with empty item channels', async () => {
    // Zero item channels, but a matching conditional rule -> the rule must win over the
    // active-account fallback (which would otherwise land in the skip branch).
    installStore({
      accounts: [{ ...ACCOUNT }],
      event: eventWith({ notification_channels: [] }),
      rules: [{ days_before: 0, channels: ['feishu'] }],
    });

    await sendReminders();

    expect(skippedInserts()).toHaveLength(0);
    expect(store.logInserts).toHaveLength(1);
    // The rule's channel ('feishu') was used; the account fallback would have been 'email'.
    expect(store.logInserts[0].params[8]).toBe('feishu');
  });
});

describe('dated iterator - no channel resolved', () => {
  it('records a skipped row with NULL event_id and the skipped counter agrees across ticks', async () => {
    // 2026-06-01 09:00:30 Asia/Shanghai -> the item dated 2026-06-08 is 7 days out.
    const iteratorNow = new Date('2026-06-01T01:00:30Z');
    installStore({ accounts: [], event: null, expiryItems: [expiryItem()] });

    const first = await sendExpiryReminders(iteratorNow);
    expect(first).toMatchObject({ candidates: 1, sent: 0, claimed: 0, skipped: 1 });

    const inserts = skippedInserts();
    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    // Dated items are not events(id): the FK-constrained column must stay NULL while the
    // claim keeps the item id (11#expiry:...) for slot dedup.
    expect(insert.params[0]).toBeNull();
    expect(insert.params[1]).toBe(1);
    expect(insert.params[3]).toBe('expiry:2026-06-01#d7#t09:00');
    expect(insert.params[4]).toBe('skipped');
    expect(insert.params[5]).toBe('no_channel_resolved');
    expect(store.claims.has('11#expiry:2026-06-01#d7#t09:00')).toBe(true);

    // Second tick in the same window: the counter still reports the skip, the record is deduped.
    const second = await sendExpiryReminders(iteratorNow);
    expect(second).toMatchObject({ sent: 0, claimed: 0, skipped: 1 });
    expect(skippedInserts()).toHaveLength(1);
    expect(skipInfoLogs()).toHaveLength(1);
  });
});
