import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 166 (wave 19): bounded reminder catch-up window.
 *
 * The cron trigger (cron-job.org on the free tier) can be down or slow for a few minutes.
 * The on-time window stays `|now - target| <= 2`; beyond it the engine now accepts a
 * bounded LATE window `[target, target + grace]` (default 10 min, ceiling 60, knob
 * `REMINDER_CATCHUP_GRACE_MINUTES`) so a missed slot is delivered once instead of being
 * lost. Dedup stays on `reminder_send_claims`: an on-time attempt and a catch-up attempt
 * for the same slot produce exactly ONE claim/row, and a slot whose send already
 * SUCCEEDED can never fire again (the success record is checked, not just the claim).
 *
 * The fixture event is due 2026-06-08 09:00 Asia/Shanghai (NOW = 01:00Z) with a 09:00
 * reminder time. All assertions drive the REAL `sendReminders` over an SQL-aware
 * in-memory store (same approach as skipped-reminders.test.ts / trigger-log-persistence).
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
    sendNotifications: vi.fn(),
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

vi.mock('../services/notifications/index.js', () => ({
  sendNotifications: mocks.sendNotifications,
  isInQuietHours: () => false,
}));

vi.mock('../services/reminder-channel-resolver.service.js', () => ({
  resolveReminderChannels: vi.fn(async () => ['email']),
}));

vi.mock('../services/event-cache.service.js', () => ({
  refreshUserEventCache: vi.fn(async () => undefined),
}));

vi.mock('../services/conflict-hint.service.js', () => ({
  getConflictHint: vi.fn(async () => null),
}));

import {
  CRON_GAP_ALERT_MINUTES,
  REMINDER_CATCH_UP_DEFAULT_MINUTES,
  resolveReminderCatchUpMinutes,
  sendReminders,
} from '../jobs/tasks.js';

const SEND_KEY = '2026-06-08#d0#t09:00';
const CATCH_UP_MSG = 'Reminder catch-up: missed slot delivered after a cron gap';

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

interface Store {
  logs: StoredLogRow[];
  logInserts: Captured[];
  claims: Set<string>;
}

let store: Store;

/** A due event whose normal window is 09:00 Asia/Shanghai on the fixture day. */
function eventFixture(): Record<string, unknown> {
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
    notification_account_ids: [77],
    reminder_days_before: null,
    reminder_time: '09:00',
    profile_id: null,
  };
}

function installStore(event: Record<string, unknown> | null = eventFixture()): void {
  store = { logs: [], logInserts: [], claims: new Set<string>() };

  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO event_trigger_logs')) {
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

    if (s.includes('FROM event_reminder_cache')) {
      return event ? { rows: [{ user_id: 1, payload: [event] }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

function catchUpWarnCalls(): unknown[][] {
  return mocks.logs.warn.mock.calls.filter(([, message]) => message === CATCH_UP_MSG);
}

/** UTC instant for a wall-clock time on 2026-06-08 in Asia/Shanghai (UTC+8). */
function shanghai(hhmm: string, ymd = '2026-06-08'): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0));
}

beforeEach(() => {
  delete process.env.REMINDER_CATCHUP_GRACE_MINUTES;
  mocks.NOW_STATE.value = shanghai('09:00');
  mocks.logs.error.mockReset();
  mocks.logs.warn.mockReset();
  mocks.logs.info.mockReset();
  mocks.logs.debug.mockReset();
  mocks.sendNotifications.mockReset();
  mocks.sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) =>
    Object.fromEntries(channels.map((ch) => [ch, { success: true }])),
  );
  installStore();
});

describe('on-time behaviour is UNCHANGED (acceptance: no regression)', () => {
  it('an attempt at target + 0m still sends exactly once', async () => {
    mocks.NOW_STATE.value = shanghai('09:00');
    await sendReminders();

    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
    expect(store.logInserts).toHaveLength(1);
    expect(store.logInserts[0].params[3]).toBe(SEND_KEY);
    expect(store.claims.has(`501#${SEND_KEY}`)).toBe(true);
    // On-time delivery must not be reported as a catch-up.
    expect(catchUpWarnCalls()).toHaveLength(0);

    await sendReminders(); // same window, second tick
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
    expect(store.logInserts).toHaveLength(1);
  });

  it('an attempt at target - 2m still sends (early on-time edge)', async () => {
    mocks.NOW_STATE.value = shanghai('08:58');
    await sendReminders();
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
    expect(store.logInserts).toHaveLength(1);
  });

  it('an attempt at target + 2m still sends (late on-time edge)', async () => {
    mocks.NOW_STATE.value = shanghai('09:02');
    await sendReminders();
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
    expect(store.logInserts).toHaveLength(1);
    expect(catchUpWarnCalls()).toHaveLength(0); // +2 is still the on-time window
  });
});

describe('bounded catch-up window', () => {
  it('a missed slot at target + grace sends exactly ONCE (the catch-up)', async () => {
    // 09:10 = target + 10 = REMINDER_CATCH_UP_DEFAULT_MINUTES
    mocks.NOW_STATE.value = shanghai('09:10');
    await sendReminders();

    expect(REMINDER_CATCH_UP_DEFAULT_MINUTES).toBe(10);
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
    expect(store.logInserts).toHaveLength(1);
    expect(store.logInserts[0].params[3]).toBe(SEND_KEY);
    expect(store.logInserts[0].params[4]).toBe('success');
    expect(store.claims.has(`501#${SEND_KEY}`)).toBe(true);

    // The catch-up is observable: one warn carrying the reused gap threshold.
    const warns = catchUpWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({
      event: 'cron.reminder_catchup',
      lateMinutes: 10,
      gapAlertMinutes: CRON_GAP_ALERT_MINUTES,
      sendKey: SEND_KEY,
    });

    // A second tick inside the same grace window hits the claim -> still exactly one row.
    await sendReminders();
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
    expect(store.logInserts).toHaveLength(1);
    expect(catchUpWarnCalls()).toHaveLength(1);
  });

  it('QA: a 5-minute cron gap around the slot still delivers exactly once', async () => {
    mocks.NOW_STATE.value = shanghai('09:05'); // first successful tick after a 5-min outage
    await sendReminders();
    mocks.NOW_STATE.value = shanghai('09:06'); // the gap is over; next tick
    await sendReminders();

    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
    expect(store.logInserts).toHaveLength(1);
    expect(store.claims.size).toBe(1);
    expect(catchUpWarnCalls()).toHaveLength(1);
  });

  it('an attempt beyond target + grace does NOT send (bounded, no silent widening)', async () => {
    mocks.NOW_STATE.value = shanghai('09:11'); // target + 11 > grace 10
    await sendReminders();

    expect(mocks.sendNotifications).not.toHaveBeenCalled();
    expect(store.logInserts).toHaveLength(0);
    expect(store.claims.size).toBe(0);
    expect(catchUpWarnCalls()).toHaveLength(0);
  });

  it('QA: a 2-day cron gap does NOT deliver a stale reminder (no yesterday-today bleed)', async () => {
    // The event was due 2026-06-08; the first tick after a two-day outage runs 2026-06-10.
    mocks.NOW_STATE.value = shanghai('09:00', '2026-06-10');
    await sendReminders();

    expect(mocks.sendNotifications).not.toHaveBeenCalled();
    expect(store.logInserts).toHaveLength(0);
    expect(store.claims.size).toBe(0);
  });
});

describe('already-succeeded slots never re-fire', () => {
  it('a slot that already SUCCEEDED does not fire again even inside the grace window', async () => {
    // Previous tick delivered this slot and the success row is the record of truth
    // (claim already cleaned up, so the success check - not the claim - must stop it).
    store.logs.push({
      id: 99,
      event_id: 501,
      user_id: 1,
      trigger_type: 'scheduled',
      trigger_date: SEND_KEY,
      status: 'success',
      error_message: null,
    });
    mocks.NOW_STATE.value = shanghai('09:05'); // inside [target, target + grace]
    await sendReminders();

    expect(mocks.sendNotifications).not.toHaveBeenCalled();
    expect(store.logInserts).toHaveLength(0);
    expect(store.claims.size).toBe(0); // the transient claim was released
    expect(catchUpWarnCalls()).toHaveLength(0);
  });

  it('a low-variance regression check: the success record blocks even without a claim', async () => {
    // Same as above but at target + 1 (inside the on-time window, not the catch-up):
    // proves the success check is independent of where in the window the tick lands.
    store.logs.push({
      id: 7,
      event_id: 501,
      user_id: 1,
      trigger_type: 'scheduled',
      trigger_date: SEND_KEY,
      status: 'success',
      error_message: null,
    });
    mocks.NOW_STATE.value = shanghai('09:01');
    await sendReminders();
    expect(mocks.sendNotifications).not.toHaveBeenCalled();
    expect(store.claims.size).toBe(0);
  });
});

describe('catch-up vs on-time race', () => {
  it('a catch-up and an on-time attempt racing for the same slot produce exactly one claim/row', async () => {
    // `sendReminders` captures getSyncedNow() synchronously before its first await, so
    // mutating the injected clock between the two calls gives a genuine interleaving:
    // call 1 runs for 09:00 (on time), call 2 for 09:05 (catch-up), both over one store.
    mocks.NOW_STATE.value = shanghai('09:00');
    const onTime = sendReminders();
    mocks.NOW_STATE.value = shanghai('09:05');
    const catchUp = sendReminders();
    await Promise.all([onTime, catchUp]);

    expect(store.claims.size).toBe(1);
    expect(store.claims.has(`501#${SEND_KEY}`)).toBe(true);
    expect(store.logInserts).toHaveLength(1); // exactly one trigger-log row
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
  });
});

describe('grace knob (configurable + bounded)', () => {
  it('defaults to 10; parses env; clamps to [0, 60]', () => {
    expect(REMINDER_CATCH_UP_DEFAULT_MINUTES).toBe(10);
    expect(resolveReminderCatchUpMinutes({})).toBe(10);
    expect(resolveReminderCatchUpMinutes({ REMINDER_CATCHUP_GRACE_MINUTES: '' })).toBe(10);
    expect(resolveReminderCatchUpMinutes({ REMINDER_CATCHUP_GRACE_MINUTES: 'abc' })).toBe(10);
    expect(resolveReminderCatchUpMinutes({ REMINDER_CATCHUP_GRACE_MINUTES: '15' })).toBe(15);
    expect(resolveReminderCatchUpMinutes({ REMINDER_CATCHUP_GRACE_MINUTES: '0' })).toBe(0);
    expect(resolveReminderCatchUpMinutes({ REMINDER_CATCHUP_GRACE_MINUTES: '-3' })).toBe(0);
    expect(resolveReminderCatchUpMinutes({ REMINDER_CATCHUP_GRACE_MINUTES: '5000' })).toBe(60);
    expect(CRON_GAP_ALERT_MINUTES).toBe(3); // the reused B29 threshold
  });

  it('REMINDER_CATCHUP_GRACE_MINUTES=0 disables catch-up (legacy ±2 restored)', async () => {
    process.env.REMINDER_CATCHUP_GRACE_MINUTES = '0';

    mocks.NOW_STATE.value = shanghai('09:05');
    await sendReminders();
    expect(mocks.sendNotifications).not.toHaveBeenCalled();
    expect(store.claims.size).toBe(0);

    // +2 still sends with the knob at 0: the on-time window is untouched.
    installStore();
    mocks.NOW_STATE.value = shanghai('09:02');
    await sendReminders();
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('a custom value widens the (still bounded) late window', async () => {
    process.env.REMINDER_CATCHUP_GRACE_MINUTES = '20';
    mocks.NOW_STATE.value = shanghai('09:20'); // target + 20 = the configured grace edge
    await sendReminders();
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
    expect(store.logInserts).toHaveLength(1);
    const warns = catchUpWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ lateMinutes: 20 });

    installStore();
    mocks.NOW_STATE.value = shanghai('09:21'); // beyond the configured grace
    await sendReminders();
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(1);
  });
});
