import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 65 acceptance: habit reminders in the SAME shared reminder job, reusing
 * `reminder_send_claims`:
 *
 * - schedule_days=[1,3,5] fires ONLY on Mon/Wed/Fri (five-day matrix)
 * - the nightly "streak at risk" nudge (default 20:00, overridable per user) fires
 *   exactly once when today's target is UNMET and never when it is already met
 * - a reminder time already in the past does NOT retroactively fire
 * - empty reminder_times / malformed schedule_days / disabled reminders are all safe
 *
 * DB + notifications + channel resolver are mocked; the weekday/period arithmetic is
 * covered by shared/src/habit-schedule.test.ts (pure functions).
 */

const { dbQuery, sendNotifications } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../services/notifications/index.js', () => ({
  sendNotifications,
}));

vi.mock('../services/reminder-channel-resolver.service.js', () => ({
  resolveReminderChannels: vi.fn(async () => ['email']),
  resolveActiveAccountChannels: vi.fn(async () => ['email']),
}));

vi.mock('../utils/ntp.js', () => ({
  DEFAULT_SYNC_TIMEZONE: 'Asia/Shanghai',
  getSyncedNow: () => new Date('2026-06-01T12:00:30Z'),
  scheduleTimeSync: vi.fn(),
  syncTime: vi.fn(),
  getSyncedTimestamp: vi.fn(async () => Date.now()),
}));

import { sendHabitReminders } from '../jobs/tasks.js';

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];
let claimedKeys: Set<string>;
let rows: Record<string, unknown>[];
let todayCounts: Map<number, number>;

function habitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 3,
    user_id: 1,
    name: '晨跑',
    icon: '🏃',
    target_per_period: 1,
    period: 'day',
    schedule_days: null,
    reminder_times: null,
    timezone: 'Asia/Shanghai',
    reminders_enabled: true,
    habit_streak_nudge_hour: null,
    ...overrides,
  };
}

function installDb(initialRows: Record<string, unknown>[], counts: Record<number, number> = {}): void {
  captured = [];
  rows = initialRows;
  todayCounts = new Map(Object.entries(counts).map(([id, count]) => [Number(id), count]));
  claimedKeys = new Set();
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.includes('FROM habits h')) {
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM habit_logs')) {
      const habitId = Number(params[0]);
      return { rows: [{ count: todayCounts.get(habitId) ?? 0 }], rowCount: 1 };
    }
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
    return { rows: [], rowCount: 0 };
  });
}

function claimKeysInserted(): string[] {
  return captured
    .filter((q) => q.sql.includes('INSERT INTO reminder_send_claims'))
    .map((q) => String(q.params[1]));
}

/** Shanghai wall-clock time on a given YMD -> UTC Date */
function atShanghai(ymd: string, hhmm: string, seconds = 30): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm, seconds));
}

beforeEach(() => {
  installDb([habitRow()]);
  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) => {
    return Object.fromEntries(channels.map((ch) => [ch, { success: true }]));
  });
});

describe('sendHabitReminders - schedule_days weekday matrix', () => {
  it('fires ONLY on Mon/Wed/Fri for schedule_days=[1,3,5] across a five-day week', async () => {
    // 2026-06-01 (Mon) .. 2026-06-05 (Fri)
    installDb([habitRow({ schedule_days: [1, 3, 5], reminder_times: ['08:00'] })]);
    const days = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];
    const fired: string[] = [];
    for (const day of days) {
      const result = await sendHabitReminders(atShanghai(day, '08:00'));
      if (result.reminded > 0) fired.push(day);
    }

    expect(fired).toEqual(['2026-06-01', '2026-06-03', '2026-06-05']);
    expect(sendNotifications).toHaveBeenCalledTimes(3);
    expect(claimKeysInserted()).toEqual([
      'habit#h3#d2026-06-01#t08:00',
      'habit#h3#d2026-06-03#t08:00',
      'habit#h3#d2026-06-05#t08:00',
    ]);

    // If schedule_days were ignored (remind every day) all five days would fire.
    expect(sendNotifications).not.toHaveBeenCalledTimes(5);
  });

  it('reminds every day when schedule_days is NULL, but only once per time slot', async () => {
    installDb([habitRow({ reminder_times: ['08:00'] })]);
    const first = await sendHabitReminders(atShanghai('2026-06-02', '08:00'));
    expect(first.reminded).toBe(1);
    // A repeat inside the +/-2 minute window hits the claim -> 0
    const second = await sendHabitReminders(new Date('2026-06-02T00:01:30Z'));
    expect(second.reminded).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });
});

describe('sendHabitReminders - nightly streak-at-risk nudge', () => {
  it('fires exactly one nudge at 20:00 when the target is unmet, then zero', async () => {
    installDb([habitRow()], { 3: 0 });
    const now = atShanghai('2026-06-01', '20:00');

    const first = await sendHabitReminders(now);
    expect(first).toMatchObject({ candidates: 1, reminded: 0, riskNudged: 1 });

    const [event] = sendNotifications.mock.calls[0] as [Record<string, unknown>];
    expect(event.type).toBe('habit_streak_risk');
    expect(event.name).toBe('晨跑');
    expect(String(event.customMessage)).toContain('晨跑');
    expect(claimKeysInserted()).toEqual(['habit:risk#h3#d2026-06-01']);

    const second = await sendHabitReminders(new Date('2026-06-01T12:01:30Z'));
    expect(second.riskNudged).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('does NOT nudge when the habit is already met', async () => {
    installDb([habitRow()], { 3: 1 });
    const result = await sendHabitReminders(atShanghai('2026-06-01', '20:00'));
    expect(result.riskNudged).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
    expect(claimKeysInserted()).toEqual([]);
  });

  it('respects target_per_period > 1 (2 of 3 nudges, 3 of 3 does not)', async () => {
    installDb([habitRow({ target_per_period: 3 })], { 3: 2 });
    const partial = await sendHabitReminders(atShanghai('2026-06-01', '20:00'));
    expect(partial.riskNudged).toBe(1);

    installDb([habitRow({ target_per_period: 3 })], { 3: 3 });
    const complete = await sendHabitReminders(atShanghai('2026-06-01', '20:00'));
    expect(complete.riskNudged).toBe(0);
  });

  it('honours a per-user nudge hour and defaults to 20:00 when malformed', async () => {
    installDb([habitRow({ habit_streak_nudge_hour: '21:30' })], { 3: 0 });
    const tooEarly = await sendHabitReminders(atShanghai('2026-06-01', '20:00'));
    expect(tooEarly.riskNudged).toBe(0);
    const onTime = await sendHabitReminders(atShanghai('2026-06-01', '21:30'));
    expect(onTime.riskNudged).toBe(1);

    installDb([habitRow({ habit_streak_nudge_hour: 'not-a-time' })], { 3: 0 });
    const fallback = await sendHabitReminders(atShanghai('2026-06-01', '20:00'));
    expect(fallback.riskNudged).toBe(1);
  });

  it('does not nudge on a day the habit is not scheduled', async () => {
    // scheduled on Tuesday (2); Monday 20:00 must produce nothing at all
    installDb([habitRow({ schedule_days: [2] })], { 3: 0 });
    const result = await sendHabitReminders(atShanghai('2026-06-01', '20:00'));
    expect(result).toMatchObject({ candidates: 1, riskNudged: 0, skipped: 1 });
    expect(claimKeysInserted()).toEqual([]);
  });
});

describe('sendHabitReminders - malformed and past inputs', () => {
  it('never retroactively fires a reminder time already in the past', async () => {
    // reminder at 08:00, job runs at 20:00; and the habit is already met (no risk nudge)
    installDb([habitRow({ reminder_times: ['08:00'] })], { 3: 1 });
    const result = await sendHabitReminders(atShanghai('2026-06-01', '20:00'));
    expect(result.reminded).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
    expect(claimKeysInserted()).toEqual([]);
  });

  it('handles empty reminder_times without crashing or sending', async () => {
    installDb([habitRow({ reminder_times: [] })], { 3: 0 });
    const result = await sendHabitReminders(atShanghai('2026-06-01', '09:00'));
    expect(result.reminded).toBe(0);
    expect(result.riskNudged).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('ignores out-of-range schedule_days and disables reminders for the user', async () => {
    installDb([habitRow({ schedule_days: [9, -1], reminder_times: ['08:00'] })]);
    const malformed = await sendHabitReminders(atShanghai('2026-06-01', '08:00'));
    // [9,-1] are all out of range -> normalized to null (= every day) -> still reminds
    expect(malformed.reminded).toBe(1);

    installDb([habitRow({ reminder_times: ['08:00'], reminders_enabled: false })]);
    sendNotifications.mockClear();
    const disabled = await sendHabitReminders(atShanghai('2026-06-01', '08:00'));
    expect(disabled.reminded).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('releases the claim when every channel fails', async () => {
    installDb([habitRow({ reminder_times: ['08:00'] })]);
    sendNotifications.mockResolvedValue({ email: { success: false, error: 'down' } });
    const result = await sendHabitReminders(atShanghai('2026-06-01', '08:00'));
    expect(result.reminded).toBe(0);
    expect(claimedKeys.size).toBe(0);
  });

  it('passes a hostile habit name only as a parameter (never into SQL)', async () => {
    const hostile = `'; DROP TABLE habit_logs;-- <b>x</b>`;
    installDb([habitRow({ name: hostile, reminder_times: ['08:00'] })]);
    const result = await sendHabitReminders(atShanghai('2026-06-01', '08:00'));
    expect(result.reminded).toBe(1);

    const [event] = sendNotifications.mock.calls[0] as [Record<string, unknown>];
    expect(event.name).toBe(hostile);
    for (const q of captured) {
      expect(q.sql).not.toContain('DROP TABLE habit_logs');
      expect(q.sql).not.toContain('<b>');
    }
  });
});
