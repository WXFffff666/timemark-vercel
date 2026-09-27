import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 69 acceptance, part 3: the reminder job evaluates the per-PROFILE
 * timezone (v41 `profiles.timezone`) where it already resolves a timezone:
 * dated iterators (expiry/inventory/maintenance/documents), cadence, habits and
 * the event path. A profile without a timezone falls back to the user timezone.
 * Notification ROUTING stays user-level (checkbox 70 is NOT built here).
 *
 * The fixtures pin a UTC instant where Asia/Shanghai and America/New_York are on
 * different calendar days, so the profile timezone changes the outcome; the
 * negative control (profile timezone absent) proves the fallback.
 */

const { dbQuery, sendNotifications, NOW_STATE } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
  NOW_STATE: { value: new Date('2026-06-08T00:30:00Z') },
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

import {
  sendCadenceReminders,
  sendExpiryReminders,
  sendHabitReminders,
  sendReminders,
} from '../jobs/tasks.js';

let captured: Array<{ sql: string; params: unknown[] }>;
let claimedKeys: Set<string>;

type Handler = (s: string, params: unknown[]) => { rows: unknown[]; rowCount: number } | null;

function installDb(handler: Handler): void {
  captured = [];
  claimedKeys = new Set();
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

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
    if (s.includes('FROM notification_accounts')) {
      return { rows: [{ type: 'email' }], rowCount: 1 };
    }
    const custom = handler(s, params);
    if (custom) return custom;
    return { rows: [], rowCount: 0 };
  });

  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) => {
    return Object.fromEntries(channels.map((ch) => [ch, { success: true }]));
  });
}

beforeEach(() => {
  installDb(() => null);
});

describe('per-profile timezone in the reminder job (checkbox 69)', () => {
  it('dated iterator: profile timezone America/New_York matches the due window that Shanghai misses', async () => {
    NOW_STATE.value = new Date('2026-06-08T00:30:00Z');
    const row = (profileTz: string | null) => ({
      id: 11,
      user_id: 1,
      profile_id: 41,
      kind: 'subscription',
      title: 'Netflix',
      next_due_date: '2026-06-14',
      is_active: true,
      reminder_config: { daysBeforeList: [7], reminderTimes: ['20:30'], channels: ['email'] },
      timezone: 'Asia/Shanghai',
      profile_timezone: profileTz,
      reminders_enabled: true,
    });

    installDb((s) => (s.includes('FROM expiry_items') ? { rows: [row('America/New_York')], rowCount: 1 } : null));
    const withProfile = await sendExpiryReminders(NOW_STATE.value);
    expect(withProfile.sent).toBe(1);
    expect(sendNotifications).toHaveBeenCalledTimes(1);

    installDb((s) => (s.includes('FROM expiry_items') ? { rows: [row(null)], rowCount: 1 } : null));
    const fallback = await sendExpiryReminders(NOW_STATE.value);
    expect(fallback.sent).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('habits: profile timezone drives the reminder_times match', async () => {
    NOW_STATE.value = new Date('2026-06-08T00:30:00Z');
    const row = (profileTz: string | null) => ({
      id: 7,
      user_id: 1,
      profile_id: 41,
      name: '晨跑',
      target_per_period: 1,
      period: 'day',
      schedule_days: null,
      reminder_times: ['20:30'],
      is_active: true,
      timezone: 'Asia/Shanghai',
      profile_timezone: profileTz,
      reminders_enabled: true,
      habit_streak_nudge_hour: '20:00',
    });

    installDb((s) => {
      if (s.includes('FROM habits h')) return { rows: [row('America/New_York')], rowCount: 1 };
      if (s.includes('FROM habit_logs')) return { rows: [{ count: 0 }], rowCount: 1 };
      return null;
    });
    const withProfile = await sendHabitReminders(NOW_STATE.value);
    expect(withProfile.reminded).toBe(1);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    expect((sendNotifications.mock.calls[0] as [Record<string, unknown>])[0].type).toBe('habit_reminder');

    installDb((s) => {
      if (s.includes('FROM habits h')) return { rows: [row(null)], rowCount: 1 };
      if (s.includes('FROM habit_logs')) return { rows: [{ count: 0 }], rowCount: 1 };
      return null;
    });
    const fallback = await sendHabitReminders(NOW_STATE.value);
    expect(fallback.reminded).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('cadence: profile timezone changes the period start and the due decision', async () => {
    // 04:30Z -> New York 2026-06-08 00:30 vs Shanghai 2026-06-08 12:30;
    // the anchor 2026-06-06T00:30Z is 06-05 in NY and 06-06 in SH -> NY is due at
    // cadence_days=3 while the Shanghai fallback is not.
    NOW_STATE.value = new Date('2026-06-08T04:30:00Z');
    const row = (profileTz: string | null) => ({
      id: 7,
      user_id: 1,
      profile_id: 41,
      name: 'Mom',
      nickname: null,
      relationship: null,
      cadence_days: 3,
      last_contact_at: null,
      effective_last_contact_at: '2026-06-06T00:30:00Z',
      last_interaction_summary: null,
      timezone: 'Asia/Shanghai',
      profile_timezone: profileTz,
      reminders_enabled: true,
    });

    installDb((s) => {
      if (s.includes('FROM fixed_contacts')) return { rows: [row('America/New_York')], rowCount: 1 };
      if (s.startsWith('INSERT INTO inbox_messages')) return { rows: [{ id: 1 }], rowCount: 1 };
      return null;
    });
    const withProfile = await sendCadenceReminders(NOW_STATE.value);
    expect(withProfile.sent).toBe(1);
    expect(sendNotifications).toHaveBeenCalledTimes(1);

    installDb((s) => {
      if (s.includes('FROM fixed_contacts')) return { rows: [row(null)], rowCount: 1 };
      if (s.startsWith('INSERT INTO inbox_messages')) return { rows: [{ id: 1 }], rowCount: 1 };
      return null;
    });
    const fallback = await sendCadenceReminders(NOW_STATE.value);
    expect(fallback.sent).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('events: the reminder job loads profiles and uses the event profile timezone', async () => {
    NOW_STATE.value = new Date('2026-06-08T00:30:00Z');
    const event = {
      id: 501,
      user_id: 1,
      name: 'NY party',
      date: '2026-06-14',
      calendar_type: 'gregorian',
      reminder_config: { enabled: true, daysBeforeList: [7], reminderTimes: ['20:30'] },
      notification_channels: ['email'],
      profile_id: 41,
    };

    const installEvents = (profileTz: string | null): void => {
      installDb((s, params) => {
        if (s.includes('FROM user_configs')) {
          return {
            rows: [{ user_id: 1, timezone: 'Asia/Shanghai', reminders_enabled: true, daily_check_time: null, days_before_list: [7], reminder_emails: [] }],
            rowCount: 1,
          };
        }
        if (s.includes('SELECT DISTINCT user_id FROM events')) return { rows: [{ user_id: 1 }], rowCount: 1 };
        if (s.includes('FROM event_reminder_cache')) return { rows: [{ user_id: 1, payload: [event] }], rowCount: 1 };
        if (s.includes('FROM profiles')) {
          return profileTz ? { rows: [{ id: 41, timezone: profileTz }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (s.includes('SELECT id FROM event_trigger_logs')) return { rows: [], rowCount: 0 };
        if (s.includes('FROM events') && Array.isArray(params[0])) return { rows: [], rowCount: 0 };
        return null;
      });
    };

    installEvents('America/New_York');
    await sendReminders();
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    expect((sendNotifications.mock.calls[0] as [Record<string, unknown>])[0].name).toBe('NY party');
    expect(captured.some((q) => q.sql.includes('FROM profiles'))).toBe(true);

    installEvents(null);
    await sendReminders();
    expect(sendNotifications).not.toHaveBeenCalled();
  });
});
