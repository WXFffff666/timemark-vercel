import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 49 acceptance: inventory items flow through the SAME reminder engine as
 * expiry items (jobs/tasks.ts runDatedReminderIterator) - one scheduler only.
 *
 * - same ±2-minute window, same channel dispatcher, same reminder_send_claims
 * - the claim key is isolated with an `inventory:` prefix
 * - a non-perishable (expires_at NULL) must NEVER fire a reminder and must not
 *   break iteration for the valid rows around it
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

import { sendInventoryReminders } from '../jobs/tasks.js';

/** 2026-06-01 01:00:30 UTC = 2026-06-01 09:00:30 Asia/Shanghai */
const NOW = new Date('2026-06-01T01:00:30Z');

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];
let claimedKeys: Set<string>;

function itemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    user_id: 1,
    profile_id: null,
    name: '鲜牛奶',
    category: 'food',
    quantity: '2',
    unit: '盒',
    low_stock_threshold: '3',
    purchased_at: '2026-05-25',
    expires_at: '2026-06-08',
    location: '冰箱',
    notes: null,
    reminder_config: { daysBeforeList: [7], reminderTimes: ['09:00'], channels: ['email', 'feishu'] },
    is_active: true,
    created_at: '2026-05-25T00:00:00.000Z',
    updated_at: '2026-05-25T00:00:00.000Z',
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

    if (s.includes('FROM inventory_items')) {
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
  installDb([itemRow()]);
  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) => {
    return Object.fromEntries(channels.map((ch) => [ch, { success: true }]));
  });
});

describe('sendInventoryReminders', () => {
  it('candidate query excludes non-perishables (expires_at IS NOT NULL) and scopes by user implicitly', async () => {
    await sendInventoryReminders(NOW);
    const q = captured.find((c) => c.sql.includes('FROM inventory_items'));
    expect(q).toBeDefined();
    expect(q!.sql).toContain('i.expires_at IS NOT NULL');
    expect(q!.sql).toContain('i.is_active = TRUE');
    expect(q!.sql).toContain('LEFT JOIN user_configs uc ON uc.user_id = i.user_id');
  });

  it('sends exactly once per configured channel for an item expiring in 7 days', async () => {
    const result = await sendInventoryReminders(NOW);

    expect(result).toMatchObject({ candidates: 1, sent: 1, claimed: 1, skipped: 0 });
    expect(sendNotifications).toHaveBeenCalledTimes(1);

    const [event, userId, channels] = sendNotifications.mock.calls[0] as [
      Record<string, unknown>,
      number,
      string[],
    ];
    expect(userId).toBe(1);
    expect(channels).toEqual(['email', 'feishu']);
    expect(event.type).toBe('inventory_food');
    expect(event.name).toBe('鲜牛奶');
    expect(event.date).toBe('2026-06-08');
    expect(event.id).toBeNull();

    const claimInsert = captured.find((q) => q.sql.includes('INSERT INTO reminder_send_claims'));
    expect(claimInsert?.params[1]).toBe('inventory:2026-06-01#d7#t09:00');
    expect(claimInsert?.params[0]).toBe(11);
  });

  it('dedupes a second run in the same window via reminder_send_claims', async () => {
    const first = await sendInventoryReminders(NOW);
    const second = await sendInventoryReminders(NOW);

    expect(first.sent).toBe(1);
    expect(second).toMatchObject({ sent: 0, claimed: 0, skipped: 1 });
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('never fires for a non-perishable, an inactive row or a past expiry - and keeps iterating', async () => {
    installDb([
      itemRow({ id: 21, name: '洗衣液', expires_at: null }), // non-perishable -> no reminder
      itemRow({ id: 22, is_active: false }), // inactive
      itemRow({ id: 23, expires_at: '2026-05-25' }), // already expired
      itemRow({ id: 24, reminders_enabled: false }), // user disabled reminders
      itemRow({ id: 25 }), // the only valid row, after all the skips
    ]);

    const result = await sendInventoryReminders(NOW);

    expect(result).toMatchObject({ candidates: 5, sent: 1, claimed: 1, skipped: 4 });
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    expect(sendNotifications.mock.calls[0][0].name).toBe('鲜牛奶');
  });

  it('uses the [30,7,3,1,0] default lead days and the ±2-minute window', async () => {
    installDb([
      itemRow({ id: 31, expires_at: '2026-07-01', reminder_config: { reminderTimes: ['09:00'], channels: ['email'] } }),
      itemRow({ id: 32, expires_at: '2026-06-06', reminder_config: { reminderTimes: ['09:00'], channels: ['email'] } }),
    ]);

    const result = await sendInventoryReminders(NOW);
    expect(result.sent).toBe(1);

    const outside = await sendInventoryReminders(new Date('2026-06-01T01:05:00Z'));
    expect(outside.sent).toBe(0);
  });
});
