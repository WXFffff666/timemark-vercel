import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 97 / defect D2: `/snooze` must persist a minute-granular deadline and the
 * reminder loop must honour it.
 *
 * The old code wrote `next_occurrence += minutes`, but `events.next_occurrence` is a DATE
 * column, so Postgres truncated the sub-day result and the delta was 0 ms while the reply
 * still claimed success. The fix persists `events.snoozed_until` (migration v51) and the
 * cron evaluates it through `evaluateSnoozeWindow`:
 *   - pending  -> do not fire,
 *   - due      -> fire once inside the ±2-minute window, claim key `snooze:event#…`,
 *   - none     -> the normal day-based schedule resumes.
 * `date` / `next_occurrence` stay canonical (the snooze stays reversible).
 */

const { dbQuery, sendNotifications, NOW_STATE } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
  NOW_STATE: { value: new Date('2026-06-08T01:00:00Z') }, // 09:00 Asia/Shanghai
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../services/notifications/index.js', () => ({ sendNotifications }));

vi.mock('../utils/ntp.js', () => ({
  getSyncedNow: () => NOW_STATE.value,
  scheduleTimeSync: vi.fn(),
  DEFAULT_SYNC_TIMEZONE: 'Asia/Shanghai',
}));

vi.mock('../services/config.service.js', () => ({
  getUserConfig: vi.fn(async () => ({ timezone: 'Asia/Shanghai' })),
  saveUserConfig: vi.fn(async () => undefined),
}));

import {
  buildSnoozeSendKey,
  evaluateSnoozeWindow,
  sendReminders,
  SNOOZE_WINDOW_MS,
} from '../jobs/tasks.js';
import { defaultBotDataProvider } from '../services/bot/bot-data.service.js';

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];
let claimedKeys: Set<string>;

type Handler = (s: string, params: unknown[]) => { rows: unknown[]; rowCount: number } | null;

function installDb(handler: Handler = () => null): void {
  captured = [];
  claimedKeys = new Set();
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = String(sql).replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO reminder_send_claims')) {
      const key = `${String(params[0])}#${String(params[1])}`;
      if (claimedKeys.has(key)) return { rows: [], rowCount: 0 };
      claimedKeys.add(key);
      return { rows: [{ event_id: params[0] }], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM reminder_send_claims')) {
      claimedKeys.delete(`${String(params[0])}#${String(params[1])}`);
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
    if (s.includes('SELECT id FROM event_trigger_logs')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM notification_accounts')) return { rows: [{ type: 'email' }], rowCount: 1 };
    const custom = handler(s, params);
    if (custom) return custom;
    return { rows: [], rowCount: 0 };
  });

  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) =>
    Object.fromEntries(channels.map((ch) => [ch, { success: true }])),
  );
}

/** A due event whose normal window is 09:00 Asia/Shanghai on the fixture day. */
function eventWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 501,
    user_id: 1,
    name: '早会',
    date: '2026-06-08',
    calendar_type: 'gregorian',
    lunar_date: null,
    reminder_config: { enabled: true, daysBeforeList: [0], reminderTimes: ['09:00'] },
    notification_channels: ['email'],
    profile_id: null,
    ...overrides,
  };
}

function installEvent(event: Record<string, unknown>): void {
  installDb((s) => (s.includes('FROM event_reminder_cache') ? { rows: [{ user_id: 1, payload: [event] }], rowCount: 1 } : null));
}

beforeEach(() => {
  NOW_STATE.value = new Date('2026-06-08T01:00:00Z');
  installDb();
});

describe('evaluateSnoozeWindow (pure)', () => {
  const now = Date.parse('2026-06-08T01:00:00Z');

  it('is none without a deadline', () => {
    expect(evaluateSnoozeWindow(null, now)).toEqual({ state: 'none' });
    expect(evaluateSnoozeWindow(undefined, now)).toEqual({ state: 'none' });
    expect(evaluateSnoozeWindow('not-a-date', now)).toEqual({ state: 'none' });
  });

  it('is pending beyond the ±2-minute window and due inside it', () => {
    expect(evaluateSnoozeWindow(new Date(now + 10 * 60_000).toISOString(), now).state).toBe('pending');
    expect(evaluateSnoozeWindow(new Date(now + 3 * 60_000).toISOString(), now).state).toBe('pending');
    expect(evaluateSnoozeWindow(new Date(now + 2 * 60_000).toISOString(), now).state).toBe('due');
    expect(evaluateSnoozeWindow(new Date(now + 60_000).toISOString(), now).state).toBe('due');
    expect(evaluateSnoozeWindow(new Date(now).toISOString(), now).state).toBe('due');
    expect(evaluateSnoozeWindow(new Date(now - 60_000).toISOString(), now).state).toBe('due');
    expect(evaluateSnoozeWindow(new Date(now - 2 * 60_000).toISOString(), now).state).toBe('due');
  });

  it('treats an already-passed window as no snooze, so the normal schedule resumes', () => {
    expect(evaluateSnoozeWindow(new Date(now - 2 * 60_000 - 1).toISOString(), now).state).toBe('none');
    expect(evaluateSnoozeWindow(new Date(now - 60 * 60_000).toISOString(), now).state).toBe('none');
  });

  it('accepts a Date value as returned by the pg driver', () => {
    expect(evaluateSnoozeWindow(new Date(now + 10 * 60_000), now)).toEqual({ state: 'pending', atMs: now + 10 * 60_000 });
  });

  it('keeps one stable dedup key across a window but a distinct one per snooze', () => {
    const deadline = Date.parse('2026-06-08T01:10:30.000Z');
    const sameMinute = Date.parse('2026-06-08T01:10:59.000Z');
    const otherMinute = Date.parse('2026-06-08T01:20:00.000Z');
    expect(buildSnoozeSendKey(501, deadline)).toBe('snooze:event#501#2026-06-08T01:10:00.000Z');
    expect(buildSnoozeSendKey(501, deadline)).toBe(buildSnoozeSendKey(501, sameMinute));
    expect(buildSnoozeSendKey(501, deadline)).not.toBe(buildSnoozeSendKey(501, otherMinute));
    expect(buildSnoozeSendKey(501, deadline)).not.toBe(buildSnoozeSendKey(502, deadline));
    expect(buildSnoozeSendKey(501, deadline)).not.toContain('#d0#t');
    expect(SNOOZE_WINDOW_MS).toBe(2 * 60_000);
  });
});

describe('defaultBotDataProvider.snoozeTodo (D2 persistence)', () => {
  it('persists snoozed_until = now + N minutes and never touches next_occurrence', async () => {
    dbQuery.mockReset();
    const calls: Captured[] = [];
    dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (String(sql).includes('RETURNING snoozed_until')) {
        return { rows: [{ snoozed_until: new Date('2026-10-05T02:10:00.000Z') }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await defaultBotDataProvider.snoozeTodo(1, 501, 10);

    expect(result).toEqual({
      status: 'ok',
      snoozedUntil: '2026-10-05T02:10:00.000Z',
      localTime: '10:10', // 02:10Z rendered in the user's Asia/Shanghai clock
    });
    const update = calls.find((c) => c.sql.includes('UPDATE events'));
    expect(update).toBeDefined();
    expect(update?.sql).toContain('snoozed_until');
    expect(update?.sql).toContain('NOW()');
    expect(update?.sql).toContain(`INTERVAL '1 minute'`);
    // The canonical schedule columns are deliberately untouched.
    expect(update?.sql).not.toContain('next_occurrence');
    expect(update?.params).toEqual([501, 1, 10]);
  });

  it('reports not_found (never a fake success) when the UPDATE matches no row', async () => {
    dbQuery.mockReset();
    dbQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await expect(defaultBotDataProvider.snoozeTodo(1, 501, 10)).resolves.toEqual({ status: 'not_found' });
  });

  it('exposes the persisted deadline on a re-read (observable state)', async () => {
    const store = { snoozed_until: null as Date | null, date: '2026-10-05', next_occurrence: '2026-10-05' };
    dbQuery.mockReset();
    dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const s = String(sql);
      if (s.includes('RETURNING snoozed_until')) {
        store.snoozed_until = new Date(Date.now() + Number(params[2]) * 60_000);
        return { rows: [{ snoozed_until: store.snoozed_until }], rowCount: 1 };
      }
      if (s.includes('SELECT snoozed_until')) {
        return { rows: [{ snoozed_until: store.snoozed_until }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const before = Date.now();
    const result = await defaultBotDataProvider.snoozeTodo(1, 501, 10);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');

    const reRead = (await dbQuery('SELECT snoozed_until FROM events WHERE id = $1', [501])).rows[0] as {
      snoozed_until: Date;
    };
    expect(reRead.snoozed_until.getTime()).toBeGreaterThanOrEqual(before + 10 * 60_000 - 5_000);
    expect(reRead.snoozed_until.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 5_000);
    expect(store.date).toBe('2026-10-05');
    expect(store.next_occurrence).toBe('2026-10-05');
  });
});

describe('sendReminders honours snoozed_until (D2 loop integration)', () => {
  it('does not fire a pending snooze even when the normal window is now', async () => {
    installEvent(eventWith({ snoozed_until: '2026-06-08T02:00:00.000Z' })); // 10:00 Shanghai
    await sendReminders();
    expect(sendNotifications).not.toHaveBeenCalled();
    expect(claimedKeys.size).toBe(0);
  });

  it('fires a due snooze once through the same claim machinery', async () => {
    NOW_STATE.value = new Date('2026-06-08T01:09:00Z'); // 09:09 Shanghai, normal window missed
    installEvent(eventWith({ snoozed_until: '2026-06-08T01:10:00.000Z' }));
    await sendReminders();

    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const claim = captured.find((c) => c.sql.includes('INSERT INTO reminder_send_claims'));
    expect(claim?.params).toEqual([501, 'snooze:event#501#2026-06-08T01:10:00.000Z']);
    const trigger = captured.find((c) => c.sql.includes('INSERT INTO event_trigger_logs'));
    expect(trigger?.params[3]).toBe('snooze:event#501#2026-06-08T01:10:00.000Z');

    // Re-read on the next tick of the same window: the claim already exists, no second send.
    await sendReminders();
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('resumes the normal schedule once the snooze window has passed', async () => {
    installEvent(eventWith({ snoozed_until: '2026-06-08T00:00:00.000Z' })); // 08:00 Shanghai, 1h stale
    await sendReminders();

    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const claim = captured.find((c) => c.sql.includes('INSERT INTO reminder_send_claims'));
    expect(claim?.params).toEqual([501, '2026-06-08#d0#t09:00']);
    expect(String(claim?.params[1])).not.toContain('snooze:');
  });

  it('ignores a malformed snoozed_until value (fail-open to the normal schedule)', async () => {
    installEvent(eventWith({ snoozed_until: 'not-a-date' }));
    await sendReminders();
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const claim = captured.find((c) => c.sql.includes('INSERT INTO reminder_send_claims'));
    expect(claim?.params).toEqual([501, '2026-06-08#d0#t09:00']);
  });
});
