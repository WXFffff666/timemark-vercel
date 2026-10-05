import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 167 acceptance: the manual test-send path (POST /api/events/:id/test-send) must
 * resolve channels through the SAME `resolveReminderChannels()` the scheduled path uses
 * (conditional rule > preset tier > event channels > the owner's own active accounts), so an
 * event with no explicitly bound channel still reaches the accounts the owner configured.
 *
 * The dispatcher is the boundary of this file: the route must hand it the RESOLVED channel list
 * (with `skipQuietHours: true`). The real resolver runs against the SQL-aware store below, and
 * `resolverSpy` proves the route called it (the single source of channel choice on both paths).
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(c, next);
    },
  };
});

const notif = vi.hoisted(() => ({ sendNotifications: vi.fn() }));
vi.mock('../services/notifications/index.js', () => notif);

const resolverSpy = vi.hoisted(() => ({ resolveReminderChannels: vi.fn() }));
vi.mock('../services/reminder-channel-resolver.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/reminder-channel-resolver.service.js')>();
  resolverSpy.resolveReminderChannels.mockImplementation(actual.resolveReminderChannels);
  return { ...actual, resolveReminderChannels: resolverSpy.resolveReminderChannels };
});

import eventsRoutes from '../routes/events.js';

const USER = { id: 1, username: 'alice' };
const TODAY = '2026-09-30';
const EVENT_ID = 501;

interface StoredAccount {
  id: number;
  name: string;
  type: string;
  is_active: boolean;
}

interface Store {
  event: Record<string, unknown> | null;
  accounts: StoredAccount[];
  ruleChannels: string[] | null;
  preset: string | null;
  logs: Array<Record<string, unknown>>;
  claims: Set<string>;
}

const TELEGRAM_ACCOUNT: StoredAccount = { id: 11, name: 'owner-telegram', type: 'telegram', is_active: true };
const EMAIL_ACCOUNT: StoredAccount = { id: 12, name: 'owner@example.com', type: 'email', is_active: true };
const INACTIVE_TELEGRAM: StoredAccount = { id: 3, name: '老账号', type: 'telegram', is_active: false };

function eventWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID,
    user_id: USER.id,
    name: '妈妈的生日',
    type: 'birthday',
    date: '2026-10-05',
    calendar_type: 'gregorian',
    lunar_date: null,
    reminder_config: { enabled: true, daysBeforeList: [0], reminderTimes: ['09:00'] },
    notification_channels: [],
    notification_account_ids: [],
    reminder_days_before: null,
    reminder_time: '09:00',
    profile_id: null,
    ...overrides,
  };
}

let store: Store;

function installStore(options: {
  event?: Record<string, unknown> | null;
  accounts?: StoredAccount[];
  ruleChannels?: string[] | null;
  preset?: string | null;
} = {}): void {
  store = {
    event: options.event === undefined ? eventWith() : options.event,
    accounts: options.accounts ?? [],
    ruleChannels: options.ruleChannels ?? null,
    preset: options.preset ?? null,
    logs: [],
    claims: new Set<string>(),
  };

  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    // v2.27：test-send 改用列清单查询，这里放宽前缀匹配以同时覆盖两种形态
    if (s.startsWith('SELECT * FROM events') || s.includes('FROM events WHERE id = $1 AND user_id = $2')) {
      return store.event ? { rows: [store.event], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM conditional_reminder_rules')) {
      return store.ruleChannels
        ? { rows: [{ days_before: 0, channels: store.ruleChannels }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT notification_preset FROM user_configs')) {
      return { rows: [{ notification_preset: store.preset }], rowCount: 1 };
    }
    if (s.startsWith('SELECT DISTINCT type FROM notification_accounts')) {
      const rows = store.accounts.filter((account) => account.is_active).map((account) => ({ type: account.type }));
      return { rows, rowCount: rows.length };
    }
    if (s.includes('SELECT id, name, type, is_active FROM notification_accounts')) {
      const ids = new Set((params[1] as number[] | undefined)?.map(Number));
      const rows = store.accounts.filter((account) => ids.has(account.id));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('INSERT INTO reminder_send_claims')) {
      const key = `${String(params[0])}#${String(params[1])}`;
      if (store.claims.has(key)) return { rows: [], rowCount: 0 };
      store.claims.add(key);
      return { rows: [{ event_id: params[0] }], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO event_trigger_logs')) {
      store.logs.push({
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
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function testSend() {
  const res = await eventsRoutes.request(`http://localhost/${EVENT_ID}/test-send`, { method: 'POST' });
  const json = (await res.json()) as {
    success?: boolean;
    error?: string;
    message?: string;
    data?: Record<string, unknown>;
  };
  return { status: res.status, json };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T04:00:00Z'));
  authState.user = { ...USER };
  notif.sendNotifications.mockReset();
  resolverSpy.resolveReminderChannels.mockClear();
  installStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/events/:id/test-send (checkbox 167)', () => {
  it("falls back to the owner's own active account when the event binds no channel", async () => {
    installStore({ accounts: [TELEGRAM_ACCOUNT] });
    notif.sendNotifications.mockResolvedValue({ telegram: { success: true } });

    const { status, json } = await testSend();

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(notif.sendNotifications).toHaveBeenCalledTimes(1);
    const [event, userId, channels, options] = notif.sendNotifications.mock.calls[0];
    expect((event as { id: number }).id).toBe(EVENT_ID);
    expect(userId).toBe(USER.id);
    expect(channels).toEqual(['telegram']);
    expect(options).toEqual({ skipQuietHours: true });
    // The successful manual send still lands in 提醒日志 (existing behaviour, unchanged).
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0].status).toBe('success');
  });

  it('routes the manual send through resolveReminderChannels (single source of channel choice)', async () => {
    installStore({
      event: eventWith({ notification_channels: ['telegram'], notification_account_ids: [11] }),
      accounts: [TELEGRAM_ACCOUNT],
    });
    notif.sendNotifications.mockResolvedValue({ telegram: { success: true } });

    await testSend();

    expect(resolverSpy.resolveReminderChannels).toHaveBeenCalledWith(USER.id, ['telegram'], 0);
  });

  it('honours an explicitly bound channel instead of widening to all active accounts', async () => {
    installStore({
      event: eventWith({ notification_channels: ['telegram'], notification_account_ids: [11] }),
      accounts: [TELEGRAM_ACCOUNT, EMAIL_ACCOUNT],
    });
    notif.sendNotifications.mockResolvedValue({ telegram: { success: true } });

    const { status } = await testSend();

    expect(status).toBe(200);
    const [, , channels] = notif.sendNotifications.mock.calls[0];
    expect(channels).toEqual(['telegram']);
    expect(channels).not.toContain('email');
  });

  it('keeps the resolution priority: a 0-day conditional rule still wins on the manual path', async () => {
    installStore({
      event: eventWith({ notification_channels: ['telegram'], notification_account_ids: [11] }),
      accounts: [TELEGRAM_ACCOUNT],
      ruleChannels: ['email'],
    });
    notif.sendNotifications.mockResolvedValue({ email: { success: true } });

    await testSend();

    const [, , channels] = notif.sendNotifications.mock.calls[0];
    expect(channels).toEqual(['email']);
  });

  it('records a skipped trigger with the no_channel_resolved reason and returns an actionable error', async () => {
    installStore({ accounts: [] });

    const first = await testSend();

    expect(first.status).toBe(400);
    expect(first.json.success).toBe(false);
    expect(first.json.error).toContain('设置 → 通知渠道');
    expect(first.json.data?.reason).toBe('no_channel_resolved');
    expect(notif.sendNotifications).not.toHaveBeenCalled();
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]).toMatchObject({
      event_id: EVENT_ID,
      user_id: USER.id,
      trigger_type: 'manual_test',
      trigger_date: TODAY,
      status: 'skipped',
      error_message: 'no_channel_resolved',
    });

    // A second press in the same slot: still an explicit 400 (never a silent drop), but the
    // reminder_send_claims dedup keeps exactly ONE skipped row.
    const second = await testSend();
    expect(second.status).toBe(400);
    expect(second.json.error).toContain('设置 → 通知渠道');
    expect(store.logs).toHaveLength(1);
  });

  it('names the explicitly bound inactive account instead of a generic message (QA failure case)', async () => {
    installStore({
      event: eventWith({ notification_channels: ['telegram'], notification_account_ids: [3] }),
      accounts: [INACTIVE_TELEGRAM],
    });
    notif.sendNotifications.mockResolvedValue({ telegram: { success: false, error: 'no_configuration' } });

    const { status, json } = await testSend();

    expect(status).toBe(400);
    expect(json.error).toContain('老账号');
    expect(json.error).toContain('#3');
    expect(json.error).toContain('已停用');
    expect(json.error).not.toContain('未找到可用通知账号');
    // The enriched message is also what lands in 提醒日志.
    expect(store.logs).toHaveLength(1);
    expect(String(store.logs[0].error_message)).toContain('老账号');
  });
});
