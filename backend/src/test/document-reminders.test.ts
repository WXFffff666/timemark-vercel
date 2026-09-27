import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 55 acceptance: document-expiry reminders flow through the SAME reminder engine
 * as expiry items / inventory / maintenance (no second scheduler, no second renderer).
 *
 * - passport / visa default to `[180, 90, 30, 7, 0]`; every other kind to `[90, 30, 7, 0]`
 * - a passport 180 days out fires on the 180-day lead; the 90-day lead (not yet arrived)
 *   is NOT claimed in that run, and fires later when the date actually arrives
 * - a past `expires_at` fires ONE final "已过期" reminder, deduped by a claim key that
 *   contains no date (exactly once, even across repeated cron runs)
 * - reminder_config.daysBeforeList still overrides the per-kind defaults
 * - claims live in the shared reminder_send_claims table with a `document:` prefix
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

import { sendDocumentReminders } from '../jobs/tasks.js';

/** 2026-06-01 01:00:30 UTC = 2026-06-01 09:00:30 Asia/Shanghai */
const NOW = new Date('2026-06-01T01:00:30Z');

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];
/** Mirrors reminder_send_claims(PRIMARY KEY(event_id, trigger_date)). */
let claimedKeys: Set<string>;

function documentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    user_id: 1,
    profile_id: null,
    kind: 'passport',
    title: '护照',
    issuer: '公安部',
    document_number_encrypted: null,
    issued_at: '2026-01-01',
    expires_at: '2026-11-28',
    country: 'CN',
    notes: null,
    reminder_config: { reminderTimes: ['09:00'], channels: ['email'] },
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

    if (s.includes('FROM documents')) {
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

function claimKeysInserted(): string[] {
  return captured
    .filter((q) => q.sql.includes('INSERT INTO reminder_send_claims'))
    .map((q) => String(q.params[1]));
}

beforeEach(() => {
  installDb([documentRow()]);
  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) => {
    return Object.fromEntries(channels.map((ch) => [ch, { success: true }]));
  });
});

describe('sendDocumentReminders - per-kind lead tables', () => {
  it('fires a passport reminder on the 180-day lead with a document: claim key', async () => {
    const result = await sendDocumentReminders(NOW);

    expect(result).toMatchObject({ candidates: 1, sent: 1, claimed: 1, skipped: 0 });
    expect(sendNotifications).toHaveBeenCalledTimes(1);

    const [event, userId, channels] = sendNotifications.mock.calls[0] as [
      Record<string, unknown>,
      number,
      string[],
    ];
    expect(userId).toBe(1);
    expect(channels).toEqual(['email']);
    expect(event.type).toBe('document_passport');
    expect(event.name).toBe('护照');
    expect(event.date).toBe('2026-11-28');
    expect(event.id).toBeNull();

    expect(claimKeysInserted()).toEqual(['document:2026-06-01#d180#t09:00']);
  });

  it('does NOT fire the 90-day lead at 180 days out, but fires it when the date arrives', async () => {
    // 180 days out: only d180 is claimed - d90 has not arrived yet.
    const at180 = await sendDocumentReminders(NOW);
    expect(at180.sent).toBe(1);
    expect(claimKeysInserted()).toEqual(['document:2026-06-01#d180#t09:00']);

    // 91 days out (2026-08-31): not a lead day -> nothing.
    const at91 = await sendDocumentReminders(new Date('2026-08-31T01:00:30Z'));
    expect(at91.sent).toBe(0);
    expect(at91.claimed).toBe(0);

    // 90 days out (2026-08-30): the 90-day lead finally fires.
    const at90 = await sendDocumentReminders(new Date('2026-08-30T01:00:30Z'));
    expect(at90.sent).toBe(1);
    expect(claimKeysInserted()).toContain('document:2026-08-30#d90#t09:00');
  });

  it('uses the shorter [90,30,7,0] set for a non-passport document', async () => {
    installDb([documentRow({ id: 21, kind: 'id_card', title: '身份证' })]);

    // 180 days out is NOT a lead day for id_card.
    const at180 = await sendDocumentReminders(NOW);
    expect(at180.sent).toBe(0);
    expect(at180.claimed).toBe(0);
    expect(claimKeysInserted()).toEqual([]);

    // 90 days out is.
    const at90 = await sendDocumentReminders(new Date('2026-08-30T01:00:30Z'));
    expect(at90.sent).toBe(1);
    const [event] = sendNotifications.mock.calls[0] as [Record<string, unknown>];
    expect(event.type).toBe('document_id_card');
    expect(claimKeysInserted()).toEqual(['document:2026-08-30#d90#t09:00']);
  });

  it('lets reminder_config.daysBeforeList override the per-kind default', async () => {
    installDb([
      documentRow({
        id: 31,
        expires_at: '2026-07-16',
        reminder_config: { daysBeforeList: [45], reminderTimes: ['09:00'], channels: ['email'] },
      }),
    ]);

    const result = await sendDocumentReminders(NOW);
    expect(result.sent).toBe(1);
    expect(claimKeysInserted()).toEqual(['document:2026-06-01#d45#t09:00']);
  });
});

describe('sendDocumentReminders - expired document final reminder', () => {
  it('fires one final 已过期 reminder exactly once for a past expires_at', async () => {
    installDb([documentRow({ id: 41, expires_at: '2026-05-20', title: '旧护照' })]);

    const first = await sendDocumentReminders(NOW);
    expect(first).toMatchObject({ sent: 1, claimed: 1 });

    const [event] = sendNotifications.mock.calls[0] as [Record<string, unknown>];
    expect(event.type).toBe('document_expired');
    expect(String(event.customMessage)).toContain('已过期');

    // The claim key has NO date component: every later run in any window is a no-op.
    expect([...claimedKeys]).toEqual(['41#document:expired#2026-05-20']);

    const second = await sendDocumentReminders(NOW);
    const third = await sendDocumentReminders(new Date('2026-06-02T01:00:30Z'));
    expect(second.sent).toBe(0);
    expect(third.sent).toBe(0);
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    // Later runs may re-attempt the INSERT, but the claim key is always the same one-shot key.
    expect(new Set(claimKeysInserted())).toEqual(new Set(['document:expired#2026-05-20']));
  });

  it('keeps the one-shot key stable for the whole window (no repeat at 09:01)', async () => {
    installDb([
      documentRow({
        id: 42,
        expires_at: '2026-05-20',
        reminder_config: { reminderTimes: ['09:00'], channels: ['email'] },
      }),
    ]);

    await sendDocumentReminders(NOW); // 09:00:30
    const nextWindow = await sendDocumentReminders(new Date('2026-06-01T01:01:30Z')); // 09:01:30 (±2 min window)
    expect(nextWindow.sent).toBe(0);
    expect(new Set(claimKeysInserted())).toEqual(new Set(['document:expired#2026-05-20']));
  });

  it('releases the expired claim on dispatch failure so the next window retries', async () => {
    installDb([documentRow({ id: 43, expires_at: '2026-05-20' })]);
    sendNotifications.mockRejectedValue(new Error('channel exploded'));

    const result = await sendDocumentReminders(NOW);
    expect(result.sent).toBe(0);
    expect(claimedKeys.size).toBe(0);
    const deletions = captured.filter((q) => q.sql.includes('DELETE FROM reminder_send_claims'));
    expect(deletions).toHaveLength(1);
    expect(deletions[0].params[1]).toBe('document:expired#2026-05-20');
  });

  it('never fires when reminders are disabled or the user opted out', async () => {
    installDb([
      documentRow({ id: 51, expires_at: '2026-05-20', reminder_config: { enabled: false } }),
      documentRow({ id: 52, expires_at: '2026-05-20', reminders_enabled: false }),
      documentRow({ id: 53, expires_at: '2026-05-20', is_active: false }),
    ]);

    const result = await sendDocumentReminders(NOW);
    expect(result.sent).toBe(0);
    expect(result.claimed).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
    expect(claimedKeys.size).toBe(0);
  });

  it('ignores rows whose reminder_config disables reminders (upcoming lead)', async () => {
    installDb([
      documentRow({
        id: 61,
        reminder_config: { enabled: false, daysBeforeList: [180], reminderTimes: ['09:00'], channels: ['email'] },
      }),
    ]);
    const result = await sendDocumentReminders(NOW);
    expect(result.sent).toBe(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });
});
