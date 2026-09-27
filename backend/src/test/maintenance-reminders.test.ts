import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 50 acceptance: maintenance reminders run through the SAME engine.
 *
 * - the date interval flows through runDatedReminderIterator (send key `maintenance:`)
 * - the usage interval surfaces as an inbox nudge within 10% of the threshold,
 *   deduped per cycle through reminder_send_claims (`maintenance:usage#<id>#u<due>`)
 * - missing usage values never nudge; reminders_enabled=false suppresses it
 */

const { dbQuery, sendNotifications, createInboxMessage } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
  createInboxMessage: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../services/notifications/index.js', () => ({
  sendNotifications,
}));

vi.mock('../services/inbox.service.js', () => ({
  createInboxMessage,
}));

import { sendMaintenanceReminders, sendMaintenanceUsageNudges } from '../jobs/tasks.js';

/** 2026-06-01 01:00:30 UTC = 2026-06-01 09:00:30 Asia/Shanghai */
const NOW = new Date('2026-06-01T01:00:30Z');

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];
let claimedKeys: Set<string>;

function planRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    user_id: 1,
    profile_id: null,
    asset_name: '大众迈腾',
    asset_kind: 'vehicle',
    interval_days: 180,
    interval_usage: 10000,
    usage_unit: 'km',
    current_usage: '62000',
    last_done_at: '2026-01-01',
    next_due_at: '2026-06-08',
    next_due_usage: '72000',
    notes: null,
    reminder_config: { daysBeforeList: [7], reminderTimes: ['09:00'], channels: ['email'] },
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    reminders_enabled: true,
    ...overrides,
  };
}

function installDb(rows: Record<string, unknown>[]): void {
  captured = [];
  claimedKeys = new Set();
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.includes('FROM maintenance_plans')) {
      return { rows, rowCount: rows.length };
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

beforeEach(() => {
  installDb([planRow()]);
  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) => {
    return Object.fromEntries(channels.map((ch) => [ch, { success: true }]));
  });
  createInboxMessage.mockReset();
  createInboxMessage.mockImplementation(async (params: Record<string, unknown>) => ({ id: 1, ...params }));
});

describe('sendMaintenanceReminders (date interval)', () => {
  it('candidate query only includes plans with a date interval', async () => {
    await sendMaintenanceReminders(NOW);
    const q = captured.find((c) => c.sql.includes('FROM maintenance_plans'));
    expect(q).toBeDefined();
    expect(q!.sql).toContain('p.next_due_at IS NOT NULL');
    expect(q!.sql).toContain('p.is_active = TRUE');
  });

  it('sends once per channel with the maintenance_<asset_kind> template and an isolated claim key', async () => {
    const result = await sendMaintenanceReminders(NOW);

    expect(result).toMatchObject({ candidates: 1, sent: 1, claimed: 1, skipped: 0 });
    const [event, , channels] = sendNotifications.mock.calls[0] as [Record<string, unknown>, number, string[]];
    expect(channels).toEqual(['email']);
    expect(event.type).toBe('maintenance_vehicle');
    expect(event.name).toBe('大众迈腾');
    expect(event.date).toBe('2026-06-08');

    const claimInsert = captured.find((q) => q.sql.includes('INSERT INTO reminder_send_claims'));
    expect(claimInsert?.params[1]).toBe('maintenance:2026-06-01#d7#t09:00');
  });

  it('a usage-only plan (next_due_at null) never fires a date reminder', async () => {
    installDb([planRow({ id: 21, interval_days: null, next_due_at: null })]);
    const result = await sendMaintenanceReminders(NOW);
    expect(result).toMatchObject({ candidates: 1, sent: 0, skipped: 1 });
    expect(sendNotifications).not.toHaveBeenCalled();
  });
});

describe('sendMaintenanceUsageNudges (usage interval, 10% threshold)', () => {
  it('nudges the inbox exactly at 10% remaining and only once per cycle', async () => {
    // current 71000, next due 72000, interval 10000 -> remaining 1000 = 10% -> nudge
    installDb([planRow({ current_usage: '71000', next_due_usage: '72000', interval_usage: '10000' })]);

    const first = await sendMaintenanceUsageNudges();
    expect(first).toMatchObject({ candidates: 1, nudged: 1, skipped: 0 });
    expect(createInboxMessage).toHaveBeenCalledTimes(1);

    const params = createInboxMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(params.userId).toBe(1);
    expect(params.source).toBe('inbound');
    expect(String(params.title)).toContain('大众迈腾');
    expect(String(params.body)).toContain('1000km');

    const claimInsert = captured.find((q) => q.sql.includes('INSERT INTO reminder_send_claims'));
    expect(claimInsert?.params[1]).toBe('maintenance:usage#11#u72000');

    // Same cycle -> deduped by claims, no second message.
    const second = await sendMaintenanceUsageNudges();
    expect(second.nudged).toBe(0);
    expect(createInboxMessage).toHaveBeenCalledTimes(1);
  });

  it('does NOT nudge just above the 10% threshold (remaining 1001)', async () => {
    installDb([planRow({ current_usage: '8999', next_due_usage: '10000', interval_usage: '10000' })]);
    const result = await sendMaintenanceUsageNudges();
    expect(result).toMatchObject({ candidates: 1, nudged: 0, skipped: 1 });
    expect(createInboxMessage).not.toHaveBeenCalled();
  });

  it('nudges when overdue (remaining negative) and when reminders_enabled is true', async () => {
    installDb([planRow({ current_usage: '10500', next_due_usage: '10000', interval_usage: '10000' })]);
    const result = await sendMaintenanceUsageNudges();
    expect(result.nudged).toBe(1);
  });

  it('never nudges with missing usage values or when alerts are disabled', async () => {
    installDb([
      planRow({ id: 31, current_usage: null }),
      planRow({ id: 32, next_due_usage: null }),
      planRow({ id: 33, interval_usage: null }),
      planRow({ id: 34, reminders_enabled: false, current_usage: '9000' }),
    ]);
    const result = await sendMaintenanceUsageNudges();
    expect(result).toMatchObject({ candidates: 4, nudged: 0, skipped: 4 });
    expect(createInboxMessage).not.toHaveBeenCalled();
  });
});
