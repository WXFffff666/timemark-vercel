import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 48 acceptance: expiry items flow through the EXISTING reminder engine.
 *
 * - same ±2-minute window logic (matchesReminderTimeWindow)
 * - same channel dispatcher (sendNotifications) - exactly one send per configured channel
 * - same reminder_send_claims dedup table (expiry:-prefixed keys) - a second run in the
 *   same window sends nothing
 * - is_active=false or a past next_due_date never fires a "coming up" reminder
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

import { sendExpiryReminders } from '../jobs/tasks.js';

/** 2026-06-01 01:00:30 UTC = 2026-06-01 09:00:30 Asia/Shanghai */
const NOW = new Date('2026-06-01T01:00:30Z');

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];
/** Mirrors reminder_send_claims(PRIMARY KEY(event_id, trigger_date)). */
let claimedKeys: Set<string>;

function itemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    user_id: 1,
    profile_id: null,
    kind: 'subscription',
    title: 'Netflix 会员',
    vendor: 'Netflix',
    amount_cents: '1999',
    currency: 'CNY',
    cycle: 'monthly',
    cycle_days: null,
    start_date: '2025-06-01',
    next_due_date: '2026-06-08',
    auto_renew: true,
    notes: null,
    tags: [],
    reminder_config: { daysBeforeList: [7], reminderTimes: ['09:00'], channels: ['email', 'feishu'] },
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

    if (s.includes('FROM expiry_items')) {
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
    // reminder-channel-resolver: no conditional rules, no preset
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  installDb([itemRow()]);
  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) => {
    return Object.fromEntries(channels.map((ch) => [ch, { success: true }]));
  });
});

describe('sendExpiryReminders', () => {
  it('sends exactly once per configured channel for an item due in 7 days inside the window', async () => {
    const result = await sendExpiryReminders(NOW);

    expect(result).toMatchObject({ candidates: 1, sent: 1, claimed: 1, skipped: 0 });

    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const [event, userId, channels] = sendNotifications.mock.calls[0] as [
      Record<string, unknown>,
      number,
      string[],
    ];
    expect(userId).toBe(1);
    expect(channels).toEqual(['email', 'feishu']);
    expect(event.type).toBe('expiry_subscription');
    expect(event.name).toBe('Netflix 会员');
    expect(event.date).toBe('2026-06-08');
    // No event id: email_logs / notification_queue FKs point at events(id).
    expect(event.id).toBeNull();

    // One result entry per configured channel.
    const results = (await sendNotifications.mock.results[0].value) as Record<string, unknown>;
    expect(Object.keys(results)).toEqual(['email', 'feishu']);

    // Dedup key is isolated from the events key space.
    const claimInsert = captured.find((q) => q.sql.includes('INSERT INTO reminder_send_claims'));
    expect(claimInsert?.params[1]).toMatch(/^expiry:2026-06-01#d7#t09:00$/);
    expect(claimInsert?.params[0]).toBe(11);
  });

  it('sends nothing on a second run in the same window (claims dedup)', async () => {
    const first = await sendExpiryReminders(NOW);
    const second = await sendExpiryReminders(NOW);

    expect(first.sent).toBe(1);
    expect(second).toMatchObject({ sent: 0, claimed: 0, skipped: 1 });
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('never fires for is_active=false or a past next_due_date', async () => {
    installDb([
      itemRow({ id: 21, is_active: false }),
      itemRow({ id: 22, next_due_date: '2026-05-25' }),
      itemRow({ id: 23, reminders_enabled: false }),
    ]);

    const result = await sendExpiryReminders(NOW);

    expect(result.sent).toBe(0);
    expect(result.claimed).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
    // Nothing was claimed, so a fixed item can still fire later.
    expect(claimedKeys.size).toBe(0);
  });

  it('uses the [30,7,3,1,0] default lead days and the ±2-minute window', async () => {
    installDb([
      // No daysBeforeList -> the [30,7,3,1,0] defaults decide; +30 days fires.
      itemRow({ id: 31, next_due_date: '2026-07-01', reminder_config: { reminderTimes: ['09:00'], channels: ['email'] } }),
      // +5 days is not a default lead day.
      itemRow({ id: 32, next_due_date: '2026-06-06', reminder_config: { reminderTimes: ['09:00'], channels: ['email'] } }),
    ]);

    const result = await sendExpiryReminders(NOW);
    expect(result.sent).toBe(1);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    expect(sendNotifications.mock.calls[0][2]).toEqual(['email']);

    // 09:05 is outside the ±2-minute window around 09:00.
    const outside = await sendExpiryReminders(new Date('2026-06-01T01:05:00Z'));
    expect(outside.sent).toBe(0);
  });

  it('ignores items whose reminder_config disables reminders', async () => {
    installDb([itemRow({ id: 41, reminder_config: { enabled: false, daysBeforeList: [7], reminderTimes: ['09:00'], channels: ['email'] } })]);
    const result = await sendExpiryReminders(NOW);
    expect(result.sent).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('releases the claim when the dispatch throws so the next window retries', async () => {
    sendNotifications.mockRejectedValue(new Error('channel exploded'));

    const result = await sendExpiryReminders(NOW);

    expect(result.sent).toBe(0);
    expect(claimedKeys.size).toBe(0);
    const deletions = captured.filter((q) => q.sql.includes('DELETE FROM reminder_send_claims'));
    expect(deletions).toHaveLength(1);
    expect(deletions[0].params[1]).toBe('expiry:2026-06-01#d7#t09:00');
  });

  it('does nothing when the user has no resolvable channels', async () => {
    installDb([itemRow({ id: 51, reminder_config: { daysBeforeList: [7], reminderTimes: ['09:00'], channels: [] } })]);
    const result = await sendExpiryReminders(NOW);
    expect(result.sent).toBe(0);
    expect(result.claimed).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });
});
