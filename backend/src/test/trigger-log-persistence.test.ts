import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 164 (wave 19): the scheduled-reminder trigger log must PERSIST and the
 * consecutive-failure counter must OBSERVE a failed send.
 *
 * History: `event_trigger_logs.trigger_date` was DATE while scheduled reminders write the
 * compound dedup key `YYYY-MM-DD#d<n>#tHH:mm`; migration v51 cast the column to TEXT
 * (`USING trigger_date::text`). The reader sweep is covered by other tests - what was
 * missing is a test that puts a row IN (every older test only read the table) and a test
 * that the counter that auto-disables a broken account actually sees a failure:
 *
 *   `trackConsecutiveFailure` (notifications/index.ts) counts 'failed' rows AFTER the last
 *   'success' row for one (account_id, channel_type) and adds +1 for the current failure.
 *   It can only reach 3 if the failed rows of the PREVIOUS attempts were persisted. While
 *   `recordEventTrigger` swallowed its INSERT, they never were -> auto-disable never fired.
 *
 * These tests drive the REAL `sendNotifications` (real counter SQL), the REAL
 * `recordEventTrigger` and the REAL `sendReminders`, backed by a SQL-aware in-memory store.
 * The real-engine PGlite proof (real INSERT + readback + DATE->TEXT data survival) lives in
 * `%TEMP%/opencode/wave19-164-triggerlog/pglite-probe.mts`.
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

import { recordEventTrigger } from '../services/trigger-log.service.js';
import { sendNotifications } from '../services/notifications/index.js';
import { sendReminders } from '../jobs/tasks.js';

const SCHEMA_SOURCE = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');
const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const TRIGGER_LOG_SERVICE_SOURCE = readFileSync(
  new URL('../services/trigger-log.service.ts', import.meta.url),
  'utf8',
);

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
  channel_results: unknown;
  error_details: unknown;
  channel_type: unknown;
  account_id: unknown;
}

interface StoredAccount {
  id: number;
  type: string;
  name: string;
  is_active: boolean;
  suspended_until?: string | null;
  webhook: string | null;
  token: string | null;
  secret: string | null;
  chat_id: string | null;
}

interface CounterCheck {
  accountId: unknown;
  channelType: unknown;
  counted: number;
}

interface Store {
  logs: StoredLogRow[];
  logInserts: Captured[];
  counterChecks: CounterCheck[];
  disabledAccountIds: number[];
  accounts: StoredAccount[];
  claims: Set<string>;
  failLogInsert: boolean;
}

const ACCOUNT_ID = 77;

const ACCOUNT: StoredAccount = {
  id: ACCOUNT_ID,
  type: 'email',
  name: 'owner@example.com',
  is_active: true,
  webhook: null,
  token: null, // config resolves, but the email dispatch requires apiKey -> deterministic failure, no network
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

let store: Store;

function installStore(options: { failLogInsert?: boolean; event?: Record<string, unknown> } = {}): void {
  const event = options.event ?? eventWith();
  store = {
    logs: [],
    logInserts: [],
    counterChecks: [],
    disabledAccountIds: [],
    accounts: [{ ...ACCOUNT }],
    claims: new Set<string>(),
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
      const row: StoredLogRow = {
        id: store.logs.length + 1,
        event_id: params[0],
        user_id: params[1],
        trigger_type: params[2],
        trigger_date: params[3],
        status: params[4],
        error_message: params[5],
        channel_results: params[6],
        error_details: params[7],
        channel_type: params[8],
        account_id: params[9],
      };
      store.logs.push(row);
      return { rows: [], rowCount: 1 };
    }

    // The real counter query (notifications/index.ts trackConsecutiveFailure), executed
    // verbatim against the store: failed rows after the last success for this pair.
    if (s.includes('SELECT COUNT(*) as fail_count FROM event_trigger_logs')) {
      const [accountId, channelType] = params;
      const matching = store.logs.filter(
        (row) => row.account_id === accountId && row.channel_type === channelType,
      );
      const lastSuccessId = matching
        .filter((row) => row.status === 'success')
        .reduce((max, row) => Math.max(max, row.id), 0);
      const counted = matching.filter((row) => row.status === 'failed' && row.id > lastSuccessId).length;
      store.counterChecks.push({ accountId, channelType, counted });
      return { rows: [{ fail_count: counted }], rowCount: 1 };
    }

    if (s.startsWith('SELECT suspended_until FROM notification_accounts')) {
      const accountId = Number(params[0]);
      const account = store.accounts.find((row) => row.id === accountId);
      return { rows: [{ suspended_until: account?.suspended_until ?? null }], rowCount: 1 };
    }

    if (s.startsWith('UPDATE notification_accounts') && s.includes('suspended_until = NOW()')) {
      // v78: 3 连败改为暂停 24h（is_active 保持 TRUE，自动恢复），不再是硬禁用。
      const accountId = Number(params[0]);
      store.disabledAccountIds.push(accountId);
      const account = store.accounts.find((row) => row.id === accountId);
      if (account) account.suspended_until = new Date(Date.now() + 86400_000).toISOString();
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('SELECT id FROM event_trigger_logs')) {
      const rows = store.logs
        .filter((row) => row.event_id === params[0] && row.trigger_date === params[1] && row.status === 'success')
        .map((row) => ({ id: row.id }));
      return { rows, rowCount: rows.length };
    }

    if (s.includes('SELECT trigger_date, status FROM event_trigger_logs')) {
      const rows = store.logs.map((row) => ({ trigger_date: row.trigger_date, status: row.status }));
      return { rows, rowCount: rows.length };
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
      return { rows: [{ user_id: 1, payload: [event] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

const COMPOUND_KEY = '2026-06-08#d0#t09:00';
const PLAIN_KEY = '2026-06-08';

beforeEach(() => {
  mocks.NOW_STATE.value = new Date('2026-06-08T01:00:00Z');
  mocks.logs.error.mockReset();
  mocks.logs.warn.mockReset();
  mocks.logs.info.mockReset();
  mocks.logs.debug.mockReset();
  installStore();
});

describe('schema <-> migration reconciliation (checkbox 164)', () => {
  it('a fresh install from schema.pg.sql declares trigger_date TEXT, the same shape v51 casts to', () => {
    // The re-scoped fix: the schema file must match the migrated end state, otherwise a fresh
    // DB starts as DATE and only becomes TEXT after runMigrations().
    expect(SCHEMA_SOURCE).toMatch(/trigger_date TEXT NOT NULL/);
    expect(SCHEMA_SOURCE).not.toMatch(/trigger_date DATE NOT NULL/);
    expect(MIGRATE_SOURCE).toContain('ALTER TABLE event_trigger_logs ALTER COLUMN trigger_date TYPE TEXT USING trigger_date::text');
    // The plain-btree index is still the right access path for an exact-equality TEXT lookup.
    expect(SCHEMA_SOURCE).toContain('CREATE INDEX IF NOT EXISTS idx_trigger_logs_date ON event_trigger_logs(trigger_date)');
  });
});

describe('recordEventTrigger persists both key shapes (the actual INSERT path)', () => {
  it('stores a compound sendKey and a plain YYYY-MM-DD, and both read back unchanged', async () => {
    const compoundRecorded = await recordEventTrigger(501, 1, 'scheduled', COMPOUND_KEY, 'failed', 'boom');
    const plainRecorded = await recordEventTrigger(501, 1, 'scheduled', PLAIN_KEY, 'success');

    // The writer reports success instead of swallowing the outcome.
    expect(compoundRecorded).toBe(true);
    expect(plainRecorded).toBe(true);
    expect(store.logInserts).toHaveLength(2);

    const readBack = await mocks.query('SELECT trigger_date, status FROM event_trigger_logs ORDER BY id');
    expect(readBack.rows).toEqual([
      { trigger_date: COMPOUND_KEY, status: 'failed' },
      { trigger_date: PLAIN_KEY, status: 'success' },
    ]);
  });

  it('returns false (never throws) when the INSERT fails - the reminder itself must survive', async () => {
    installStore({ failLogInsert: true });
    await expect(recordEventTrigger(501, 1, 'scheduled', COMPOUND_KEY, 'failed')).resolves.toBe(false);
    expect(store.logs).toHaveLength(0);
    expect(mocks.logs.error).toHaveBeenCalled();
  });
});

describe('the consecutive-failure counter observes a failed send and the 24h suspension fires', () => {
  it('counts each persisted failed row and suspends the account on the 3rd consecutive failure', async () => {
    const event = eventWith();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Exactly the production order: sendNotifications runs the counter check, then the
      // caller persists the trigger-log row for this attempt.
      const results = await sendNotifications(event, 1, ['email']);
      expect(results.email?.success).toBe(false);
      expect(results.email?.accountId).toBe(ACCOUNT_ID);

      const recorded = await recordEventTrigger(
        Number(event.id),
        1,
        'scheduled',
        COMPOUND_KEY,
        'failed',
        results.email?.error,
        JSON.stringify(results),
        { channel_type: 'email', account_id: ACCOUNT_ID },
      );
      expect(recorded).toBe(true);

      if (attempt < 3) expect(store.disabledAccountIds).toEqual([]);
    }

    // The counter executed once per attempt and SAW the rows persisted by previous attempts:
    expect(store.counterChecks.map((check) => check.counted)).toEqual([0, 1, 2]);
    // 2 persisted failures + 1 current = 3 consecutive -> 24h suspension (is_active stays TRUE).
    expect(store.disabledAccountIds).toEqual([ACCOUNT_ID]);
    expect(store.accounts[0].is_active).toBe(true);
    expect(store.accounts[0].suspended_until).toBeTruthy();
  });

  it('a success row resets the streak (the counter is not a lifetime failure count)', async () => {
    const event = eventWith();

    await sendNotifications(event, 1, ['email']);
    await recordEventTrigger(Number(event.id), 1, 'scheduled', COMPOUND_KEY, 'failed', 'boom', undefined, {
      channel_type: 'email',
      account_id: ACCOUNT_ID,
    });
    // A later successful send writes a success row for the same pair...
    await recordEventTrigger(Number(event.id), 1, 'scheduled', COMPOUND_KEY, 'success', undefined, undefined, {
      channel_type: 'email',
      account_id: ACCOUNT_ID,
    });
    // ...so the next failure's count restarts from 0 (+1 = 1).
    await sendNotifications(event, 1, ['email']);
    expect(store.counterChecks[store.counterChecks.length - 1]?.counted).toBe(0);
    expect(store.disabledAccountIds).toEqual([]);
  });
});

describe('a full simulated scheduled send writes exactly ONE row with the correct status', () => {
  it('sendReminders persists one failed row for the compound key and never a second one for the same slot', async () => {
    await sendReminders();

    expect(store.logInserts).toHaveLength(1);
    const [insert] = store.logInserts;
    expect(insert.params[0]).toBe(501);
    expect(insert.params[1]).toBe(1);
    expect(insert.params[2]).toBe('scheduled');
    expect(insert.params[3]).toBe(COMPOUND_KEY);
    expect(insert.params[4]).toBe('failed');
    expect(insert.params[8]).toBe('email');
    expect(insert.params[9]).toBe(ACCOUNT_ID);

    // Second tick in the same window: the claim short-circuits before any new write.
    await sendReminders();
    expect(store.logInserts).toHaveLength(1);
    expect(store.logs).toHaveLength(1);
  });

  it('surfaces a failed log write instead of swallowing it (counter-blind error is explicit)', async () => {
    installStore({ failLogInsert: true });

    await expect(sendReminders()).resolves.toBeUndefined();
    expect(store.logs).toHaveLength(0);

    const surfaced = mocks.logs.error.mock.calls.find(
      ([, message]) =>
        typeof message === 'string' &&
        message.includes('consecutive-failure counter will NOT observe this failed send'),
    );
    expect(surfaced).toBeDefined();
  });
});

describe('writer contract (source guard)', () => {
  it('recordEventTrigger declares a boolean result and the swallow is gone', () => {
    expect(TRIGGER_LOG_SERVICE_SOURCE).toContain('): Promise<boolean> {');
    expect(TRIGGER_LOG_SERVICE_SOURCE).toContain('return false;');
    expect(TRIGGER_LOG_SERVICE_SOURCE).toContain('return true;');
  });
});
