import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 62 acceptance: cadence reminders flow through the SAME reminder job
 * (sendReminders -> sendCadenceReminders) as expiry / documents / inventory / maintenance,
 * share `reminder_send_claims`, and never nag daily.
 *
 * - dedup key = contact id + period start (day of the effective last contact in the
 *   user's timezone). 30-day cadence + 31-day gap -> exactly ONE reminder.
 * - re-running inside the same period -> ZERO (claim conflict).
 * - logging an interaction today moves the period start -> next reminder only after
 *   another full period, with a NEW key.
 * - a never-contacted contact (effective last contact NULL) is SKIPPED (no "never" spam)
 *   even though GET /api/contacts/due lists it for the UI.
 * - every dispatch also writes an Inbox message with the "已记录联系" quick action.
 *
 * The DB is mocked; claim/period semantics are additionally proven against PGlite in
 * the live harness (see evidence).
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
  getSyncedNow: () => new Date('2026-06-15T01:00:30Z'),
  scheduleTimeSync: vi.fn(),
  syncTime: vi.fn(),
  getSyncedTimestamp: vi.fn(async () => Date.now()),
}));

import { sendCadenceReminders, sendReminders } from '../jobs/tasks.js';

/** 2026-06-15 01:00:30Z = 2026-06-15 09:00:30 Asia/Shanghai */
const NOW = new Date('2026-06-15T01:00:30Z');

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];
/** Mirrors reminder_send_claims(PRIMARY KEY(event_id, trigger_date)). */
let claimedKeys: Set<string>;
let rows: Record<string, unknown>[];

function cadenceContactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    user_id: 1,
    name: '张三',
    nickname: null,
    relationship: '朋友',
    cadence_days: 30,
    last_contact_at: '2026-05-15T00:00:00.000Z',
    effective_last_contact_at: new Date('2026-05-15T00:00:00.000Z'),
    last_interaction_summary: '一起喝茶',
    timezone: 'Asia/Shanghai',
    reminders_enabled: true,
    ...overrides,
  };
}

function installDb(initialRows: Record<string, unknown>[], opts: { keepClaims?: boolean } = {}): void {
  captured = [];
  rows = initialRows;
  if (!opts.keepClaims) claimedKeys = new Set();
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.includes('FROM fixed_contacts')) {
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
    if (s.startsWith('INSERT INTO inbox_messages')) {
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    // reminder-channel-resolver / inbox defaults
    return { rows: [], rowCount: 0 };
  });
}

function claimKeysInserted(): string[] {
  return captured
    .filter((q) => q.sql.includes('INSERT INTO reminder_send_claims'))
    .map((q) => String(q.params[1]));
}

function inboxInserts(): Captured[] {
  return captured.filter((q) => q.sql.replace(/\s+/g, ' ').startsWith('INSERT INTO inbox_messages'));
}

beforeEach(() => {
  installDb([cadenceContactRow()]);
  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) => {
    return Object.fromEntries(channels.map((ch) => [ch, { success: true }]));
  });
});

describe('sendCadenceReminders - one per period, never daily nagging', () => {
  it('fires exactly one reminder for a 30-day cadence with a 31-day gap, then zero', async () => {
    const first = await sendCadenceReminders(NOW);
    expect(first).toMatchObject({ candidates: 1, sent: 1, inbox: 1, skipped: 0 });
    expect(sendNotifications).toHaveBeenCalledTimes(1);

    const [event, userId, channels] = sendNotifications.mock.calls[0] as [
      Record<string, unknown>,
      number,
      string[],
    ];
    expect(userId).toBe(1);
    expect(channels).toEqual(['email']);
    expect(event.type).toBe('contact_cadence');
    expect(event.name).toBe('张三');
    expect(event.id).toBeNull();
    expect(String(event.customMessage)).toContain('张三');
    expect(String(event.customMessage)).toContain('朋友');
    expect(String(event.customMessage)).toContain('一起喝茶');

    // 去重键 = 联系人 id + 周期起点
    expect(claimKeysInserted()).toEqual(['contact:cadence#c7#p2026-05-15']);

    const second = await sendCadenceReminders(NOW);
    expect(second.sent).toBe(0);
    expect(second.inbox).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('writes an Inbox message with the 已记录联系 quick action on dispatch', async () => {
    await sendCadenceReminders(NOW);

    const inserts = inboxInserts();
    expect(inserts).toHaveLength(1);
    const params = inserts[0].params;
    expect(params[0]).toBe(1);
    expect(String(params[1])).toContain('关系维系提醒：张三');
    expect(String(params[2])).toContain('已记录联系');
    expect(String(params[2])).toContain('/contacts?contactId=7&log=1');
    expect(params[3]).toBe('inbound');
  });

  it('resets the window after an interaction: no same-day re-fire, next fire only after a full period', async () => {
    const first = await sendCadenceReminders(NOW);
    expect(first.sent).toBe(1);
    expect(claimKeysInserted()).toEqual(['contact:cadence#c7#p2026-05-15']);

    // User logs an interaction today -> effective last contact = today (Shanghai 06-15).
    // Keep the claim table (same DB): the OLD period must not re-fire.
    rows = [
      cadenceContactRow({
        last_contact_at: '2026-06-15T01:00:00.000Z',
        effective_last_contact_at: new Date('2026-06-15T01:00:00.000Z'),
        last_interaction_summary: '今天通了电话',
      }),
    ];
    const sameDay = await sendCadenceReminders(NOW);
    expect(sameDay.sent).toBe(0);
    expect(sameDay.skipped).toBe(1);
    expect(claimKeysInserted()).toEqual(['contact:cadence#c7#p2026-05-15']);

    // 30 days later (2026-07-15): due again with a NEW period-start key.
    const later = await sendCadenceReminders(new Date('2026-07-15T01:00:30Z'));
    expect(later.sent).toBe(1);
    expect(claimKeysInserted()).toEqual([
      'contact:cadence#c7#p2026-05-15',
      'contact:cadence#c7#p2026-06-15',
    ]);
  });

  it('does not fire before the period is actually over', async () => {
    rows = [
      cadenceContactRow({
        last_contact_at: '2026-06-15T00:00:00.000Z',
        effective_last_contact_at: new Date('2026-06-15T00:00:00.000Z'),
      }),
    ];
    const result = await sendCadenceReminders(NOW);
    expect(result.sent).toBe(0);
    expect(claimKeysInserted()).toEqual([]);
  });
});

describe('sendCadenceReminders - skip rules', () => {
  it('skips a contact with NO prior interactions at all (never contacted) without any claim', async () => {
    rows = [
      cadenceContactRow({
        id: 8,
        name: '从未联系',
        last_contact_at: null,
        effective_last_contact_at: null,
        last_interaction_summary: null,
      }),
    ];
    const result = await sendCadenceReminders(NOW);
    expect(result).toMatchObject({ candidates: 1, sent: 0, inbox: 0, skipped: 1 });
    expect(sendNotifications).not.toHaveBeenCalled();
    expect(claimKeysInserted()).toEqual([]);
    // The UI due list still shows this contact: GET /api/contacts/due is a separate
    // query (listDueContacts) whose null-branch is proven in the v39 live harness.
  });

  it('skips cadence_days = NULL even when cadence_enabled = TRUE', async () => {
    rows = [cadenceContactRow({ cadence_days: null })];
    const result = await sendCadenceReminders(NOW);
    expect(result.sent).toBe(0);
    expect(claimKeysInserted()).toEqual([]);
  });

  it('skips users who disabled reminders', async () => {
    rows = [cadenceContactRow({ reminders_enabled: false })];
    const result = await sendCadenceReminders(NOW);
    expect(result.sent).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('releases the claim when every channel fails so the next window can retry', async () => {
    sendNotifications.mockResolvedValue({ email: { success: false, error: 'boom' } });
    const result = await sendCadenceReminders(NOW);
    expect(result.sent).toBe(0);
    expect(claimedKeys.size).toBe(0);
    const deletions = captured.filter((q) => q.sql.includes('DELETE FROM reminder_send_claims'));
    expect(deletions).toHaveLength(1);
    expect(deletions[0].params[1]).toBe('contact:cadence#c7#p2026-05-15');
  });
});

describe('sendCadenceReminders - hostile input', () => {
  it('keeps a hostile contact name out of SQL and only sends it as a parameter', async () => {
    const hostile = `'; DROP TABLE fixed_contacts;-- <script>alert(1)</script>`;
    rows = [cadenceContactRow({ name: hostile, relationship: `'; DELETE FROM users;--` })];
    const result = await sendCadenceReminders(NOW);
    expect(result.sent).toBe(1);

    // The name reaches the notification verbatim through parameters, never concatenated.
    const [event] = sendNotifications.mock.calls[0] as [Record<string, unknown>];
    expect(event.name).toBe(hostile);

    for (const q of captured) {
      expect(q.sql).not.toContain('DROP TABLE fixed_contacts');
      expect(q.sql).not.toContain('DELETE FROM users');
      expect(q.sql).not.toContain('<script>');
    }
    // createInboxMessage sanitizes HTML tags out of the stored body.
    const body = String(inboxInserts()[0]?.params[2] ?? '');
    expect(body).not.toContain('<script>');
    expect(body).toContain('已记录联系');
  });
});

describe('sendReminders wiring', () => {
  it('calls the cadence and habit iterators from the one shared reminder job', async () => {
    installDb([]); // every query returns empty
    await sendReminders();

    const sqls = captured.map((q) => q.sql.replace(/\s+/g, ' '));
    expect(sqls.some((s) => s.includes('FROM fixed_contacts'))).toBe(true);
    expect(sqls.some((s) => s.includes('FROM habits h'))).toBe(true);
    // Still the same single job: the pre-existing iterators are also present.
    expect(sqls.some((s) => s.includes('FROM expiry_items'))).toBe(true);
    expect(sqls.some((s) => s.includes('FROM documents'))).toBe(true);
  });
});
