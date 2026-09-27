import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 73 acceptance: per-time medication reminders, snooze, the +30 min
 * escalation and the critical-vs-non-critical quiet-hours rule.
 *
 * The job reads `medication_doses` rows directly (no ±2 min `reminder_time`
 * model - doses carry their own absolute `scheduled_for`), dedupes through
 * reminder_send_claims and dispatches through the existing notification
 * dispatcher with the dedicated `medication_*` templates.
 */

const { dbQuery, sendNotifications, NOW_STATE } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
  NOW_STATE: { value: new Date('2026-09-28T00:00:00Z') },
}));

vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));

const { resolveReminderChannels } = vi.hoisted(() => ({ resolveReminderChannels: vi.fn(async () => ['email']) }));
vi.mock('../services/reminder-channel-resolver.service.js', () => ({
  resolveReminderChannels,
  resolveProfileRoutedAccountIds: vi.fn(async () => null),
}));

vi.mock('../services/notifications/index.js', async () => {
  const actual = await vi.importActual<typeof import('../services/notifications/index.js')>(
    '../services/notifications/index.js',
  );
  return { ...actual, sendNotifications };
});

vi.mock('../utils/ntp.js', () => ({
  getSyncedNow: () => NOW_STATE.value,
  scheduleTimeSync: vi.fn(),
  DEFAULT_SYNC_TIMEZONE: 'Asia/Shanghai',
}));

import { sendMedicationReminders } from '../jobs/tasks.js';
import { MEDICATION_ESCALATION_MINUTES, MEDICATION_SNOOZE_MINUTES } from '@timemark/shared';

let claimedKeys: Set<string>;
let doses: Array<Record<string, unknown>>;
let snoozeClaims: Array<{ event_id: number; trigger_date: string }>;
let captured: Array<{ sql: string; params: unknown[] }>;

function dose(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    user_id: 1,
    medication_id: 1,
    scheduled_for: '2026-09-28T00:00:00.000Z',
    status: 'pending',
    name: '二甲双胍',
    dosage: '500mg',
    units_per_dose: 1,
    is_critical: false,
    profile_id: null,
    timezone: 'Asia/Shanghai',
    quiet_hours_start: null,
    quiet_hours_end: null,
    reminders_enabled: true,
    ...overrides,
  };
}

function installDb(): void {
  captured = [];
  claimedKeys = new Set();
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.includes('FROM medication_doses d')) {
      return { rows: doses, rowCount: doses.length };
    }
    if (s.includes('FROM reminder_send_claims') && s.includes('LIKE')) {
      return { rows: snoozeClaims, rowCount: snoozeClaims.length };
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

  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) =>
    Object.fromEntries(channels.map((ch) => [ch, { success: true }])),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  doses = [];
  snoozeClaims = [];
  installDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('medication reminders (checkbox 73)', () => {
  it('fires exactly one reminder per scheduled time per day', async () => {
    const morning = dose({ id: 1, scheduled_for: '2026-09-28T00:00:00.000Z' }); // 08:00 Shanghai
    const evening = dose({ id: 2, scheduled_for: '2026-09-28T12:00:00.000Z' }); // 20:00 Shanghai
    doses = [morning, evening];

    // 08:00
    vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const run1 = await sendMedicationReminders(new Date('2026-09-28T00:00:00Z'));
    expect(run1.reminded).toBe(1);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    expect((sendNotifications.mock.calls[0] as [Record<string, unknown>])[0].type).toBe('medication_reminder');

    // same slot re-run -> deduped
    const run2 = await sendMedicationReminders(new Date('2026-09-28T00:01:00Z'));
    expect(run2.reminded).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(1);

    // 20:00 -> the other dose fires once
    const run3 = await sendMedicationReminders(new Date('2026-09-28T12:00:00Z'));
    expect(run3.reminded).toBe(1);
    expect(sendNotifications).toHaveBeenCalledTimes(2);
    // and never twice for the same slot
    const run4 = await sendMedicationReminders(new Date('2026-09-28T12:01:00Z'));
    expect(run4.reminded).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(2);
  });

  it('fires the +30 min escalation once while pending and zero times after logging', async () => {
    doses = [dose({ id: 3, scheduled_for: '2026-09-28T00:00:00.000Z' })];

    const thirty = new Date(new Date('2026-09-28T00:00:00Z').getTime() + MEDICATION_ESCALATION_MINUTES * 60_000);
    expect(MEDICATION_ESCALATION_MINUTES).toBe(30);
    const esc1 = await sendMedicationReminders(thirty);
    expect(esc1.escalated).toBe(1);
    expect(esc1.reminded).toBe(0);
    expect((sendNotifications.mock.calls[0] as [Record<string, unknown>])[0].type).toBe('medication_escalation');

    const esc2 = await sendMedicationReminders(thirty);
    expect(esc2.escalated).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(1);

    // Logged dose is no longer a candidate -> zero escalation.
    doses = [];
    const afterLog = await sendMedicationReminders(thirty);
    expect(afterLog.escalated).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('sends a snooze reminder once when the snooze window is due', async () => {
    doses = [dose({ id: 4, scheduled_for: '2026-09-28T00:00:00.000Z' })];
    const snoozeAt = new Date(new Date('2026-09-28T00:00:00Z').getTime() + MEDICATION_SNOOZE_MINUTES * 60_000).toISOString();
    snoozeClaims = [{ event_id: 4, trigger_date: `med:snooze#4#${snoozeAt}` }];

    const run1 = await sendMedicationReminders(new Date(snoozeAt));
    expect(run1.snoozed).toBe(1);
    expect((sendNotifications.mock.calls[0] as [Record<string, unknown>])[0].type).toBe('medication_snooze');

    const run2 = await sendMedicationReminders(new Date(snoozeAt));
    expect(run2.snoozed).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('critical medication bypasses quiet hours, non-critical does not', async () => {
    // 02:00 Shanghai = 18:00Z the previous day; quiet hours 22:00-07:00.
    vi.setSystemTime(new Date('2026-09-27T18:00:00Z'));
    const at0200 = '2026-09-27T18:00:00.000Z';
    doses = [
      dose({ id: 5, is_critical: true, scheduled_for: at0200, quiet_hours_start: '22:00', quiet_hours_end: '07:00' }),
      dose({ id: 6, is_critical: false, scheduled_for: at0200, quiet_hours_start: '22:00', quiet_hours_end: '07:00' }),
    ];

    const run = await sendMedicationReminders(new Date(at0200));
    expect(run.reminded).toBe(1);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const event = (sendNotifications.mock.calls[0] as [Record<string, unknown>, number, string[], { skipQuietHours: boolean }]);
    expect(event[3].skipQuietHours).toBe(true);
    expect(event[0].name).toBe('二甲双胍');

    // At 12:00 Shanghai (not quiet) both fire.
    vi.setSystemTime(new Date('2026-09-28T04:00:00Z'));
    doses = [
      dose({ id: 7, is_critical: false, scheduled_for: '2026-09-28T04:00:00.000Z', quiet_hours_start: '22:00', quiet_hours_end: '07:00' }),
    ];
    const daytime = await sendMedicationReminders(new Date('2026-09-28T04:00:00.000Z'));
    expect(daytime.reminded).toBe(1);
  });

  it('a medication that is not materialised for today (start_date tomorrow) fires nothing', async () => {
    doses = []; // materialisation respects start_date -> no rows for today
    const run = await sendMedicationReminders(new Date('2026-09-28T00:00:00Z'));
    expect(run.candidates).toBe(0);
    expect(run.reminded).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('releases the claim when no channel is configured (retried next window)', async () => {
    doses = [dose({ id: 8, scheduled_for: '2026-09-28T00:00:00.000Z' })];
    resolveReminderChannels.mockResolvedValueOnce([]);

    const run = await sendMedicationReminders(new Date('2026-09-28T00:00:00Z'));
    expect(run.reminded).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
    const released = captured.some((q) => q.sql.includes('DELETE FROM reminder_send_claims'));
    expect(released).toBe(true);
  });
});
