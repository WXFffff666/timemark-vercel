import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 105 acceptance: deterministic behavioural-pattern miner.
 *
 * Plan acceptance proof points:
 *  - seeded log: 12 reminders at 08:00 with 10 delivered + 12 at 21:00 with 1 delivered
 *    -> `kind='reminder_time'` with confidence >= 0.7 for 08:00, and NO surfaced pattern
 *    for 21:00 (its row is stored at < 0.5 confidence);
 *  - patterns below 0.5 are STORED but NOT returned by the API (`GET /api/patterns`);
 *  - a user with zero data emits nothing and does not error;
 *  - the same absolute instants bucket differently when `user_configs.timezone` changes
 *    (hour buckets come from the user's IANA timezone, not the host clock).
 *
 * The DB is mocked; every assertion below is about the miner's own computation and the
 * SQL it emits (the migration test covers the table shape).
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(
        c,
        next,
      );
    },
  };
});

import {
  PATTERN_KINDS,
  SURFACED_MIN_CONFIDENCE,
  confidenceForEvidence,
  hourBucketInTimeZone,
  listPatterns,
  parseJsonObject,
  parseReminderTriggerToken,
  recomputeAllUserPatterns,
  recomputePatterns,
} from '../services/patterns.service.js';
import patternsRoutes from '../routes/patterns.js';

interface Seed {
  timezone?: string | null;
  users?: Array<Record<string, unknown>>;
  triggers?: Array<Record<string, unknown>>;
  accounts?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  claims?: string[];
  habits?: Array<Record<string, unknown>>;
  habitLogs?: Array<Record<string, unknown>>;
  contacts?: Array<Record<string, unknown>>;
  interactions?: Array<Record<string, unknown>>;
  patterns?: Array<Record<string, unknown>>;
}

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];

function installDb(seed: Seed = {}): void {
  captured = [];
  const timezone = seed.timezone === undefined ? 'Asia/Shanghai' : seed.timezone;
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.includes('FROM user_configs')) {
      const rows = timezone == null ? [] : [{ timezone }];
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM event_trigger_logs')) {
      const rows = seed.triggers ?? [];
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM notification_accounts')) {
      const rows = seed.accounts ?? [];
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM reminder_send_claims')) {
      const rows = (seed.claims ?? []).map((trigger_date) => ({ trigger_date }));
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM habit_logs')) {
      const rows = seed.habitLogs ?? [];
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM habits')) {
      const rows = seed.habits ?? [];
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM fixed_contacts')) {
      const rows = seed.contacts ?? [];
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM interactions')) {
      const rows = seed.interactions ?? [];
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM user_patterns')) {
      const [userId, minConfidence, kind] = params as [number, number, string?];
      let rows = (seed.patterns ?? []).filter(
        (row) => Number(row.user_id) === Number(userId) && Number(row.confidence) >= Number(minConfidence),
      );
      if (typeof kind === 'string') rows = rows.filter((row) => String(row.kind) === kind);
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM events')) {
      const rows = seed.events ?? [];
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('INSERT INTO user_patterns')) {
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM user_patterns')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM users')) {
      const rows = seed.users ?? [{ id: 1 }];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function insertedPatterns(): Array<{
  kind: string;
  key: string;
  confidence: number;
  evidence_count: number;
  value: Record<string, unknown>;
}> {
  return captured
    .filter((q) => q.sql.replace(/\s+/g, ' ').trim().startsWith('INSERT INTO user_patterns'))
    .map((q) => ({
      kind: String(q.params[1]),
      key: String(q.params[2]),
      confidence: Number(q.params[4]),
      evidence_count: Number(q.params[5]),
      value: JSON.parse(String(q.params[3])) as Record<string, unknown>,
    }));
}

function reminderAttempt(
  createdAt: string,
  status: 'success' | 'failed',
  time: string,
  day = '2026-09-01',
): Record<string, unknown> {
  return {
    trigger_date: `${day}#d0#t${time}`,
    status,
    created_at: createdAt,
    channel_results: { email: { success: status === 'success' } },
  };
}

/** 12 attempts in one hour bucket: `successes` delivered, the rest failed. */
function attemptsInHour(createdAt: string, time: string, successes: number): Record<string, unknown>[] {
  return Array.from({ length: 12 }, (_, index) =>
    reminderAttempt(createdAt, index < successes ? 'success' : 'failed', time),
  );
}

beforeEach(() => {
  authState.user = { id: 1, username: 'admin' };
  installDb();
});

describe('patterns miner - plan acceptance', () => {
  it('acceptance: 10/12 at 08:00 -> reminder_time conf >= 0.7; 1/12 at 21:00 -> stored below 0.5 and not surfaced', async () => {
    installDb({
      triggers: [
        // 00:00Z == 08:00 Asia/Shanghai; 13:00Z == 21:00 Asia/Shanghai.
        ...attemptsInHour('2026-09-01T00:00:00Z', '08:00', 10),
        ...attemptsInHour('2026-09-01T13:00:00Z', '21:00', 1),
      ],
    });

    const computed = await recomputePatterns(1);
    const eight = computed.find((p) => p.kind === 'reminder_time' && p.key === '08:00');
    const nine = computed.find((p) => p.kind === 'reminder_time' && p.key === '21:00');

    expect(eight).toBeDefined();
    expect(eight?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(eight?.evidence_count).toBe(10);
    expect(eight?.value).toMatchObject({ hour: '08:00', acted_on: 10, ignored: 2, verdict: 'acted_on' });

    // Stored (it becomes meaningful as evidence grows) ...
    expect(nine).toBeDefined();
    expect(nine?.evidence_count).toBe(1);
    expect(nine?.confidence).toBeLessThan(0.5);
    expect(nine?.value).toMatchObject({ hour: '21:00', acted_on: 1, ignored: 11, verdict: 'ignored' });

    // ... both rows are written, but only 08:00 clears the surface threshold.
    const written = insertedPatterns().filter((p) => p.kind === 'reminder_time');
    expect(written.map((p) => p.key).sort()).toEqual(['08:00', '21:00']);
    expect(written.filter((p) => p.confidence >= SURFACED_MIN_CONFIDENCE).map((p) => p.key)).toEqual(['08:00']);
  });

  it('acceptance: a stored pattern below 0.5 is never returned by the API', async () => {
    installDb({
      patterns: [
        {
          id: 1,
          user_id: 1,
          kind: 'reminder_time',
          key: '08:00',
          value: { hour: '08:00' },
          confidence: '0.900',
          evidence_count: 10,
          computed_at: '2026-09-29T00:00:00.000Z',
        },
        {
          id: 2,
          user_id: 1,
          kind: 'reminder_time',
          key: '21:00',
          value: { hour: '21:00' },
          confidence: '0.300',
          evidence_count: 1,
          computed_at: '2026-09-29T00:00:00.000Z',
        },
      ],
    });

    const data = await listPatterns(1);
    expect(data.map((p) => p.key)).toEqual(['08:00']);
    expect(data[0].confidence).toBe(0.9);

    const select = captured.find((q) => q.sql.includes('FROM user_patterns'));
    expect(select).toBeDefined();
    expect(select?.sql).toContain('confidence >= $2');
    expect(select?.params).toEqual([1, SURFACED_MIN_CONFIDENCE]);
    expect(SURFACED_MIN_CONFIDENCE).toBe(0.5);
  });

  it('acceptance: a run with zero data emits nothing and does not error', async () => {
    installDb({ timezone: null });

    const computed = await recomputePatterns(1);
    expect(computed).toEqual([]);
    expect(insertedPatterns()).toEqual([]);
    // Stale rows are still cleared, so a data wipe cannot leave old preferences behind.
    expect(captured.some((q) => q.sql.includes('DELETE FROM user_patterns'))).toBe(true);

    await expect(recomputeAllUserPatterns()).resolves.toEqual({ users: 1, patterns: 0 });
    expect(insertedPatterns()).toEqual([]);
  });

  it('QA timezone recompute: the same instants bucket by user_configs.timezone, not the host clock', async () => {
    const triggers = Array.from({ length: 10 }, () =>
      reminderAttempt('2026-09-01T00:00:00Z', 'success', '08:00'),
    );

    installDb({ timezone: 'Asia/Shanghai', triggers });
    const shanghai = (await recomputePatterns(1)).filter((p) => p.kind === 'reminder_time');
    expect(shanghai.map((p) => p.key)).toEqual(['08:00']);
    // Delete-then-insert ordering: changing the timezone cannot leave both buckets behind.
    const deleteIndex = captured.findIndex((q) => q.sql.includes('DELETE FROM user_patterns'));
    const firstInsertIndex = captured.findIndex((q) => q.sql.includes('INSERT INTO user_patterns'));
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(firstInsertIndex).toBeGreaterThan(deleteIndex);

    installDb({ timezone: 'America/New_York', triggers });
    const newYork = (await recomputePatterns(1)).filter((p) => p.kind === 'reminder_time');
    // 00:00Z is 20:00 EDT on the previous day.
    expect(newYork.map((p) => p.key)).toEqual(['20:00']);
    expect(newYork[0].key).not.toBe(shanghai[0].key);
    expect(newYork[0].confidence).toBe(shanghai[0].confidence);
  });
});

describe('patterns miner - remaining kinds come from existing logs only', () => {
  it('mines lead_time, channel, weekday_type, snooze_frequency, habit_weekday and contact_cadence', async () => {
    installDb({
      triggers: [reminderAttempt('2026-09-01T00:00:00Z', 'success', '08:00')],
      accounts: [{ type: 'telegram', is_active: false, connection_status: null }],
      events: [
        { event_type: 'birthday', date: '2026-09-01' },
        { event_type: 'birthday', date: '2026-09-08' },
        { event_type: 'anniversary', date: '2026-09-08' },
      ],
      claims: [
        '2026-09-01#d0#t08:00',
        '2026-09-02#d1#t08:00',
        'snooze:event#1#2026-09-02T00:00:00.000Z',
      ],
      habits: [{ id: 3, schedule_days: [1], created_at: '2026-06-01T00:00:00.000Z' }],
      habitLogs: [{ habit_id: 3, logged_on: '2026-09-07' }],
      contacts: [{ id: 9, name: '张三', cadence_days: 30 }],
      interactions: [
        { contact_id: 9, occurred_at: '2026-07-01T00:00:00Z' },
        { contact_id: 9, occurred_at: '2026-08-15T00:00:00Z' },
      ],
    });

    const computed = await recomputePatterns(1);
    const kinds = new Set(computed.map((p) => p.kind));
    for (const kind of PATTERN_KINDS) {
      expect(kinds.has(kind), `missing kind ${kind}`).toBe(true);
    }

    const lead = computed.find((p) => p.kind === 'lead_time' && p.key === 'd0');
    expect(lead?.value).toMatchObject({ lead_days: 0, kept: 1, missed: 0 });

    const channel = computed.find((p) => p.kind === 'channel' && p.key === 'email');
    expect(channel?.value).toMatchObject({ success: 1, failed: 0, verdict: 'reliable' });
    const disabledChannel = computed.find((p) => p.kind === 'channel' && p.key === 'telegram');
    expect(disabledChannel?.value).toMatchObject({ disabled_accounts: 1, verdict: 'disabled' });
    expect(disabledChannel?.confidence).toBeLessThan(SURFACED_MIN_CONFIDENCE);

    const weekday = computed.find((p) => p.kind === 'weekday_type' && p.key === '2');
    expect(weekday?.value).toMatchObject({ weekday: 2, total: 3, types: { birthday: 2, anniversary: 1 } });

    const snooze = computed.find((p) => p.kind === 'snooze_frequency');
    expect(snooze?.value).toMatchObject({ reminders: 2, snoozes: 1, snooze_rate: 0.5 });

    const habit = computed.find((p) => p.kind === 'habit_weekday' && p.key === '1');
    expect(habit).toBeDefined();
    expect(Number(habit?.value.completed)).toBeGreaterThanOrEqual(1);
    expect(Number(habit?.value.scheduled)).toBeGreaterThanOrEqual(Number(habit?.value.completed));

    const cadence = computed.find((p) => p.kind === 'contact_cadence');
    expect(cadence?.key).toBe('contact:9');
    expect(cadence?.evidence_count).toBe(1);
    expect(cadence?.value).toMatchObject({ contact_id: 9, cadence_days: 30, samples: 1 });
    expect(Number(cadence?.value.drift_days)).toBe(Number(cadence?.value.avg_gap_days) - 30);
  });

  it('never truncates a namespaced trigger_date key and skips malformed channel payloads', () => {
    expect(parseReminderTriggerToken('2026-09-01#d0#t08:00')).toEqual({
      ymd: '2026-09-01',
      leadDays: 0,
      time: '08:00',
    });
    // `snooze:event#...` carries no leading date: exact token or nothing.
    expect(parseReminderTriggerToken('snooze:event#1#2026-09-01T00:00:00.000Z')).toBeNull();
    expect(parseReminderTriggerToken('2026-09-01')).toBeNull();

    expect(parseJsonObject('{"email":{"success":true}}')).toEqual({ email: { success: true } });
    expect(parseJsonObject({ email: { success: false } })).toEqual({ email: { success: false } });
    expect(parseJsonObject('not json')).toEqual({});
    expect(parseJsonObject(['email'])).toEqual({});

    expect(hourBucketInTimeZone('2026-09-01T00:00:00Z', 'Asia/Shanghai')).toBe('08:00');
    expect(hourBucketInTimeZone('2026-09-01T00:00:00Z', 'Not/AZone')).toBeNull();
    expect(hourBucketInTimeZone('not a date', 'Asia/Shanghai')).toBeNull();
  });

  it('confidence is a deterministic function of the evidence count', () => {
    expect(confidenceForEvidence(0)).toBe(0);
    expect(confidenceForEvidence(1)).toBeLessThan(0.5);
    expect(confidenceForEvidence(2)).toBeLessThan(0.5);
    expect(confidenceForEvidence(3)).toBeGreaterThanOrEqual(0.5);
    expect(confidenceForEvidence(5)).toBeGreaterThanOrEqual(0.7);
    expect(confidenceForEvidence(9)).toBeGreaterThanOrEqual(0.7);
    expect(confidenceForEvidence(10)).toBeGreaterThanOrEqual(0.9);
    expect(confidenceForEvidence(100)).toBeGreaterThanOrEqual(0.9);
  });

  it('ships no LLM / network import and no type or console escapes', () => {
    const source = readFileSync(new URL('../services/patterns.service.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('services/ai');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/openai|anthropic|gemini/i);
    expect(source).not.toMatch(/\bas any\b|@ts-ignore/);
    expect(source).not.toMatch(/console\.log/);
  });
});

describe('GET /api/patterns', () => {
  it('is auth-guarded, filters below 0.5 confidence, and rejects an unknown kind', async () => {
    installDb({
      patterns: [
        { id: 1, user_id: 1, kind: 'reminder_time', key: '08:00', value: { hour: '08:00' }, confidence: '0.900', evidence_count: 10, computed_at: null },
        { id: 2, user_id: 1, kind: 'reminder_time', key: '21:00', value: { hour: '21:00' }, confidence: '0.300', evidence_count: 1, computed_at: null },
      ],
    });

    authState.user = null;
    const unauthorized = await patternsRoutes.request('/');
    expect(unauthorized.status).toBe(401);

    authState.user = { id: 1, username: 'admin' };
    const ok = await patternsRoutes.request('/');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { success: boolean; data: Array<{ key: string; confidence: number }> };
    expect(body.success).toBe(true);
    expect(body.data.map((p) => p.key)).toEqual(['08:00']);

    const filtered = await patternsRoutes.request('/?kind=reminder_time');
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as { data: Array<{ key: string }> };
    expect(filteredBody.data.map((p) => p.key)).toEqual(['08:00']);

    const bad = await patternsRoutes.request('/?kind=nope');
    expect(bad.status).toBe(400);
  });
});
