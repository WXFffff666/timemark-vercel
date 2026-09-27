import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 78 — integration of holiday-aware + 节气 reminders in `jobs/tasks.ts`.
 *
 * Pinned dataset facts (chinese-days@1.5.9):
 * - 2026-10-01 .. 2026-10-07 = 国庆节 (休); 2026-10-08 = first workday.
 * - 2026-09-26/27 = 中秋 (休, Sat/Sun); 2026-09-28 = workday.
 * - 2026-10-10 = 调休 班 (Saturday workday).
 *
 * The notification dispatcher is mocked; the RESOLUTION logic under test is real
 * (the dated iterator, the event path, the jieqi sweeper, medication).
 */

const { dbQuery, sendNotifications, NOW_STATE } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
  NOW_STATE: { value: new Date('2026-10-01T01:00:30Z') },
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../services/notifications/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/notifications/index.js')>();
  return { ...actual, sendNotifications };
});

vi.mock('../utils/ntp.js', () => ({
  getSyncedNow: () => NOW_STATE.value,
  scheduleTimeSync: vi.fn(),
  DEFAULT_SYNC_TIMEZONE: 'Asia/Shanghai',
}));

import {
  sendExpiryReminders,
  sendJieqiReminders,
  sendMedicationReminders,
  sendReminders,
} from '../jobs/tasks.js';

type Handler = (s: string, params: unknown[]) => { rows: unknown[]; rowCount: number } | null;

let captured: Array<{ sql: string; params: unknown[] }>;
let claimedKeys: Set<string>;

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
  sendNotifications.mockImplementation(async (_e: unknown, _u: number, channels: string[]) =>
    Object.fromEntries(channels.map((ch) => [ch, { success: true }])),
  );
}

/** UTC instant for a wall-clock time in Asia/Shanghai (UTC+8). */
function shanghai(ymd: string, hhmm: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 30));
}

function expiryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    user_id: 1,
    profile_id: null,
    kind: 'subscription',
    title: 'Netflix 会员',
    next_due_date: '2026-10-08',
    is_active: true,
    reminder_config: { daysBeforeList: [7], reminderTimes: ['09:00'], channels: ['email'] },
    timezone: 'Asia/Shanghai',
    reminders_enabled: true,
    holiday_reminder_mode: 'keep',
    ...overrides,
  };
}

beforeEach(() => {
  installDb(() => null);
});

describe('dated iterator — holiday-aware (checkbox 78)', () => {
  it('keep (default): a reminder due on 国庆节 carries the holiday name in the content', async () => {
    installDb((s) => (s.includes('FROM expiry_items') ? { rows: [expiryRow()], rowCount: 1 } : null));
    const result = await sendExpiryReminders(shanghai('2026-10-01', '09:00'));

    expect(result).toMatchObject({ sent: 1 });
    const [, , , options] = sendNotifications.mock.calls[0] as [unknown, number, string[], Record<string, unknown>];
    expect(String(options.holidayLabel)).toContain('国庆节');
    expect(String(options.holidayLabel)).toBe('今日国庆节（法定假日）');
  });

  it('shift: nothing on the holiday, then exactly once on the next workday (2026-10-08)', async () => {
    const row = { rows: [expiryRow({ holiday_reminder_mode: 'shift' })], rowCount: 1 };

    installDb((s) => (s.includes('FROM expiry_items') ? row : null));
    const onHoliday = await sendExpiryReminders(shanghai('2026-10-01', '09:00'));
    expect(onHoliday.sent).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();

    installDb((s) => (s.includes('FROM expiry_items') ? row : null));
    const onWorkday = await sendExpiryReminders(shanghai('2026-10-08', '09:00'));
    expect(onWorkday.sent).toBe(1);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const [, , , options] = sendNotifications.mock.calls[0] as [unknown, number, string[], Record<string, unknown>];
    expect(options.holidayLabel).toBe('法定假日「国庆节」顺延提醒');
    // the postponed reminder keeps the original due-day identity in the claim key
    const claim = captured.find((q) => q.sql.includes('INSERT INTO reminder_send_claims'));
    expect(String(claim?.params[1])).toMatch(/^expiry:2026-10-01#d7#t09:00$/);
  });

  it('shift: a holiday that fell on a weekend (中秋 Sat/Sun) still resolves on the workday', async () => {
    // due 2026-09-26 (Sat holiday) with a same-day (0) lead → replay on 2026-09-28 (Mon workday)
    const row = {
      rows: [expiryRow({ next_due_date: '2026-09-26', holiday_reminder_mode: 'shift', reminder_config: { daysBeforeList: [0], reminderTimes: ['09:00'], channels: ['email'] } })],
      rowCount: 1,
    };
    installDb((s) => (s.includes('FROM expiry_items') ? row : null));
    const result = await sendExpiryReminders(shanghai('2026-09-28', '09:00'));

    expect(result.sent).toBe(1);
    const [, , , options] = sendNotifications.mock.calls[0] as [unknown, number, string[], Record<string, unknown>];
    expect(options.holidayLabel).toBe('法定假日「中秋」顺延提醒');
  });

  it('suppress: a holiday-day reminder is dropped entirely', async () => {
    installDb((s) =>
      s.includes('FROM expiry_items') ? { rows: [expiryRow({ holiday_reminder_mode: 'suppress' })], rowCount: 1 } : null,
    );
    const result = await sendExpiryReminders(shanghai('2026-10-01', '09:00'));
    expect(result.sent).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('fail-open: an uncovered year (2031) still sends on the original schedule', async () => {
    const row = {
      rows: [expiryRow({ next_due_date: '2031-10-08', holiday_reminder_mode: 'shift' })],
      rowCount: 1,
    };
    installDb((s) => (s.includes('FROM expiry_items') ? row : null));
    const result = await sendExpiryReminders(new Date('2031-10-01T01:00:30Z'));

    expect(result.sent).toBe(1);
    const [, , , options] = sendNotifications.mock.calls[0] as [unknown, number, string[], Record<string, unknown>];
    expect(options.holidayLabel).toBeUndefined();
  });

  it('documents (document expiry) never receive a holiday label — even with shift configured', async () => {
    // sendDocumentReminders goes through the non-holiday-aware DOCUMENT_SOURCE; the
    // config row may say shift, but the iterator must ignore it.
    const { sendDocumentReminders } = await import('../jobs/tasks.js');
    const doc = {
      id: 21,
      user_id: 1,
      profile_id: null,
      kind: 'passport',
      title: '护照',
      expires_at: '2026-10-08',
      is_active: true,
      reminder_config: { daysBeforeList: [7], reminderTimes: ['09:00'], channels: ['email'] },
      timezone: 'Asia/Shanghai',
      reminders_enabled: true,
      holiday_reminder_mode: 'shift',
    };
    installDb((s) => (s.includes('FROM documents') ? { rows: [doc], rowCount: 1 } : null));
    const result = await sendDocumentReminders(shanghai('2026-10-01', '09:00'));

    expect(result.sent).toBe(1);
    const [, , , options] = sendNotifications.mock.calls[0] as [unknown, number, string[], Record<string, unknown>];
    expect(options.holidayLabel).toBeUndefined();
  });
});

describe('event path — holiday-aware (checkbox 78)', () => {
  function installEvents(mode: string, event: Record<string, unknown>): void {
    installDb((s, params) => {
      if (s.includes('FROM user_configs')) {
        return {
          rows: [{ user_id: 1, timezone: 'Asia/Shanghai', reminders_enabled: true, daily_check_time: null, days_before_list: [0], reminder_emails: [], holiday_reminder_mode: mode }],
          rowCount: 1,
        };
      }
      if (s.includes('SELECT DISTINCT user_id FROM events')) return { rows: [{ user_id: 1 }], rowCount: 1 };
      if (s.includes('FROM event_reminder_cache')) return { rows: [{ user_id: 1, payload: [event] }], rowCount: 1 };
      if (s.includes('FROM profiles')) return { rows: [], rowCount: 0 };
      if (s.includes('SELECT id FROM event_trigger_logs')) return { rows: [], rowCount: 0 };
      if (s.includes('FROM events') && Array.isArray(params[0])) return { rows: [], rowCount: 0 };
      return null;
    });
  }

  const holidayEvent = {
    id: 501,
    user_id: 1,
    name: '国庆节假期开始',
    date: '2026-10-01',
    calendar_type: 'gregorian',
    reminder_config: { enabled: true, daysBeforeList: [0], reminderTimes: ['09:00'] },
    notification_channels: ['email'],
    profile_id: null,
  };

  it('keep: an event due on 2026-10-01 sends with the holiday name in the label', async () => {
    NOW_STATE.value = shanghai('2026-10-01', '09:00');
    installEvents('keep', holidayEvent);
    await sendReminders();

    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const [, , , options] = sendNotifications.mock.calls[0] as [unknown, number, string[], Record<string, unknown>];
    expect(options.holidayLabel).toBe('今日国庆节（法定假日）');
  });

  it('shift: the event reminder moves off the holiday onto the next workday', async () => {
    NOW_STATE.value = shanghai('2026-10-01', '09:00');
    installEvents('shift', holidayEvent);
    await sendReminders();
    expect(sendNotifications).not.toHaveBeenCalled(); // holiday day is suppressed

    NOW_STATE.value = shanghai('2026-10-08', '09:00');
    installEvents('shift', holidayEvent);
    await sendReminders();
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const [, , , options] = sendNotifications.mock.calls[0] as [unknown, number, string[], Record<string, unknown>];
    expect(options.holidayLabel).toBe('法定假日「国庆节」顺延提醒');
  });
});

describe('节气 reminders (checkbox 78)', () => {
  function configRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      user_id: 1,
      timezone: 'Asia/Shanghai',
      reminders_enabled: true,
      daily_check_time: '09:00:00',
      jieqi_reminder_list: ['寒露'],
      ...overrides,
    };
  }

  it('fires exactly once on the chosen 节气 day and never again that day', async () => {
    installDb((s) => (s.includes('FROM user_configs') ? { rows: [configRow()], rowCount: 1 } : null));

    const first = await sendJieqiReminders(shanghai('2026-10-08', '09:00'));
    expect(first).toMatchObject({ sent: 1 });
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const [event] = sendNotifications.mock.calls[0] as [Record<string, unknown>];
    expect(event.type).toBe('jieqi_reminder');
    expect(String(event.customMessage)).toContain('寒露');
    const claim = captured.find((q) => q.sql.includes('INSERT INTO reminder_send_claims'));
    expect(String(claim?.params[1])).toBe('jieqi#u1#2026-10-08');

    const second = await sendJieqiReminders(shanghai('2026-10-08', '09:00'));
    expect(second.sent).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(1); // still exactly once
  });

  it('does not fire on a non-节气 day, or when 寒露 is not selected', async () => {
    installDb((s) => (s.includes('FROM user_configs') ? { rows: [configRow()], rowCount: 1 } : null));
    const notJieqi = await sendJieqiReminders(shanghai('2026-10-01', '09:00'));
    expect(notJieqi.sent).toBe(0);

    installDb((s) =>
      s.includes('FROM user_configs') ? { rows: [configRow({ jieqi_reminder_list: ['春分'] })], rowCount: 1 } : null,
    );
    const notSelected = await sendJieqiReminders(shanghai('2026-10-08', '09:00'));
    expect(notSelected.sent).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('is OFF by default (empty list) and ignores a malformed selection', async () => {
    installDb((s) => (s.includes('FROM user_configs') ? { rows: [configRow({ jieqi_reminder_list: [] })], rowCount: 1 } : null));
    expect((await sendJieqiReminders(shanghai('2026-10-08', '09:00'))).sent).toBe(0);

    installDb((s) => (s.includes('FROM user_configs') ? { rows: [configRow({ jieqi_reminder_list: 'not-json' })], rowCount: 1 } : null));
    expect((await sendJieqiReminders(shanghai('2026-10-08', '09:00'))).sent).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });
});

describe('medication reminders are untouched by checkbox 78', () => {
  it('a medication dose on 国庆节 still fires exactly as before, with no holiday label', async () => {
    const dose = {
      id: 31,
      user_id: 1,
      medication_id: 5,
      scheduled_for: '2026-10-01T01:00:00.000Z', // 09:00 Asia/Shanghai
      status: 'pending',
      name: '降压药',
      dosage: '5mg',
      units_per_dose: 1,
      is_critical: false,
      profile_id: null,
      timezone: 'Asia/Shanghai',
      quiet_hours_start: null,
      quiet_hours_end: null,
      reminders_enabled: true,
    };
    installDb((s) => (s.includes('FROM medication_doses') ? { rows: [dose], rowCount: 1 } : null));

    const result = await sendMedicationReminders(new Date('2026-10-01T01:00:30Z'));
    expect(result).toMatchObject({ reminded: 1 });
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const [event, , , options] = sendNotifications.mock.calls[0] as [Record<string, unknown>, number, string[], Record<string, unknown>];
    expect(event.type).toBe('medication_reminder');
    expect(options.holidayLabel).toBeUndefined();
    expect(String(event.customMessage ?? '')).not.toContain('国庆节');
  });
});
