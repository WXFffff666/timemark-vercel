import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dateStringInTimeZone, shiftCalendarDays } from '@timemark/shared/habit-schedule';

/**
 * Checkbox 67 — Wave 8 verification on REAL data shapes (test-only).
 *
 * Three messy realities + one failure scenario, all through the real routes/job:
 *
 * 1. a contact with 500 interactions: the timeline endpoint paginates (page 1 is
 *    bounded by `limit`, pages partition the set, an un-paginated response would
 *    carry all 500 rows). The REAL millisecond measurement lives in the PGlite live
 *    harness (`.omo/evidence/task-67-*`); this file locks the route/SQL contract.
 * 2. a habit with a 400-day history: the grid returns ONLY the requested window
 *    (30-day and 399-day windows out of a 400-day history, oldest day excluded),
 *    and the streak over 400 consecutive days is 400.
 * 3. a cadence reminder across a cron retry: the SHARED reminder job
 *    (`sendReminders`) invoked twice with the SAME clock dispatches exactly one
 *    reminder (reminder_send_claims conflict).
 *
 * Failure scenario: a contact deleted mid-timeline-pagination must not 500.
 * - deleted between two page requests -> 404 (no data query runs);
 * - deleted between the ownership probe and the data read (same request) -> a clean
 *   empty page (200, data [], total 0).
 *
 * The DB is mocked (no reachable Postgres here); the same fixtures are re-run against
 * a live PGlite (WASM Postgres) engine over the pg wire protocol in the harness, where
 * the ms are recorded.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery, sendNotifications } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
}));

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

import contactRoutes from '../routes/contacts.js';
import habitRoutes from '../routes/habits.js';
import { sendReminders } from '../jobs/tasks.js';

const USER = { id: 7, username: 'alice' };
const CONTACT_ID = 5;
const HABIT_ID = 9;
const SHANGHAI = 'Asia/Shanghai';
const TODAY = dateStringInTimeZone(new Date(), SHANGHAI);

interface Captured {
  sql: string;
  params: unknown[];
}

type Responder = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number | null } | undefined;

let captured: Captured[];

function installDb(responder: Responder): void {
  captured = [];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    return responder(sql, params) ?? { rows: [], rowCount: 0 };
  });
}

function queriesMatching(pattern: RegExp): Captured[] {
  return captured.filter((q) => pattern.test(q.sql.replace(/\s+/g, ' ')));
}

async function requestContacts(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await contactRoutes.request(path, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

async function requestHabits(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await habitRoutes.request(path, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  return (body.data ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  authState.user = { ...USER };
  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) => {
    return Object.fromEntries(channels.map((ch) => [ch, { success: true }]));
  });
});

// ---------------------------------------------------------------------------
// Fixture 1 — a contact with 500 interactions
// ---------------------------------------------------------------------------

const HOSTILE_SUMMARY = `'); DROP TABLE interactions;-- <script>alert(1)</script>`;
const INTERACTION_FIXTURE_SIZE = 500;

/** Newest-first interaction rows, exactly the shape listContactTimeline returns. */
function buildInteractionRows(count: number): Array<Record<string, unknown>> {
  const baseMs = Date.parse('2026-09-01T12:00:00.000Z');
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i += 1) {
    const at = new Date(baseMs - i * 60_000).toISOString();
    rows.push({
      type: 'interaction',
      id: count - i,
      at,
      interaction_kind: 'call',
      summary: i === 3 ? HOSTILE_SUMMARY : `互动 #${count - i}`,
      mood: null,
      promise_text: null,
      due_at: null,
      done_at: null,
      gift_description: null,
      direction: null,
      occasion: null,
      amount_cents: null,
      created_at: at,
    });
  }
  return rows;
}

interface TimelineState {
  alive: boolean;
  rows: Array<Record<string, unknown>>;
  /** Simulates a delete between the ownership probe and the page read. */
  countAfterDelete: boolean;
}

function timelineResponder(state: TimelineState): Responder {
  return (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id FROM fixed_contacts WHERE id = $1 AND user_id = $2')) {
      return state.alive ? { rows: [{ id: CONTACT_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.includes('::int AS count')) {
      const total = state.countAfterDelete ? 0 : state.rows.length;
      return { rows: [{ count: total }], rowCount: 1 };
    }
    if (s.includes('UNION ALL')) {
      if (state.countAfterDelete) return { rows: [], rowCount: 0 };
      const limit = Number(params[params.length - 2]);
      const offset = Number(params[params.length - 1]);
      const page = state.rows.slice(offset, offset + limit);
      return { rows: page, rowCount: page.length };
    }
    return undefined;
  };
}

describe('fixture 1: timeline for a contact with 500 interactions', () => {
  it('page 1 is bounded by the default limit (an un-paginated read would carry all 500 rows)', async () => {
    const rows = buildInteractionRows(INTERACTION_FIXTURE_SIZE);
    installDb(timelineResponder({ alive: true, rows, countAfterDelete: false }));

    const { status, body } = await requestContacts('GET', `/${CONTACT_ID}/timeline`);

    expect(status).toBe(200);
    const items = body.data as Array<Record<string, unknown>>;
    // The fixture really holds 500 rows: the assertion below is the detector for a
    // pagination regression (LIMIT/OFFSET dropped -> 500 items, test fails).
    expect(rows).toHaveLength(INTERACTION_FIXTURE_SIZE);
    expect(items).toHaveLength(50);
    expect(items.length).toBeLessThan(rows.length);
    expect(body.pagination).toEqual({ page: 1, limit: 50, total: 500, totalPages: 10 });

    // Newest first: the first row is the highest id in the fixture.
    expect(items[0].id).toBe(INTERACTION_FIXTURE_SIZE);

    // SQL contract locked: caller-scoped + LIMIT $3 OFFSET $4 with [50, 0].
    const [timelineQuery] = queriesMatching(/UNION ALL/);
    expect(timelineQuery.params.slice(0, 2)).toEqual([USER.id, CONTACT_ID]);
    expect(timelineQuery.params.slice(-2)).toEqual([50, 0]);
    expect(timelineQuery.sql.replace(/\s+/g, ' ')).toContain('LIMIT $3 OFFSET $4');
  });

  it('pages partition the 500-row timeline with no duplicates and an empty page past the end', async () => {
    const rows = buildInteractionRows(INTERACTION_FIXTURE_SIZE);
    installDb(timelineResponder({ alive: true, rows, countAfterDelete: false }));

    const seen = new Set<number>();
    for (let page = 1; page <= 10; page += 1) {
      const { status, body } = await requestContacts('GET', `/${CONTACT_ID}/timeline?page=${page}&limit=50`);
      expect(status).toBe(200);
      const items = body.data as Array<Record<string, unknown>>;
      expect(items, `page ${page}`).toHaveLength(50);
      for (const item of items) {
        const id = Number(item.id);
        expect(seen.has(id), `id ${id} returned twice`).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(INTERACTION_FIXTURE_SIZE);

    // No page 11 data -> clean empty page, still 200 with the full total.
    const past = await requestContacts('GET', `/${CONTACT_ID}/timeline?page=11&limit=50`);
    expect(past.status).toBe(200);
    expect(past.body.data).toEqual([]);
    expect((past.body.pagination as Record<string, unknown>).total).toBe(INTERACTION_FIXTURE_SIZE);
  });

  it('keeps a hostile interaction summary as data (never SQL, never truncated out)', async () => {
    const rows = buildInteractionRows(INTERACTION_FIXTURE_SIZE);
    installDb(timelineResponder({ alive: true, rows, countAfterDelete: false }));

    const { status, body } = await requestContacts('GET', `/${CONTACT_ID}/timeline`);
    expect(status).toBe(200);
    const items = body.data as Array<Record<string, unknown>>;
    // The payload sits at fixture index 3, so it is on page 1 and must round-trip.
    expect(items.some((item) => item.summary === HOSTILE_SUMMARY)).toBe(true);

    for (const q of captured) {
      expect(q.sql).not.toContain('DROP TABLE interactions');
      expect(q.sql).not.toContain('<script>');
    }
  });

  it('malformed pagination input falls back to the safe defaults (negative / non-numeric)', async () => {
    const rows = buildInteractionRows(INTERACTION_FIXTURE_SIZE);
    installDb(timelineResponder({ alive: true, rows, countAfterDelete: false }));

    const negative = await requestContacts('GET', `/${CONTACT_ID}/timeline?page=-3&limit=-10`);
    expect(negative.status).toBe(200);
    expect(queriesMatching(/UNION ALL/)[0].params.slice(-2)).toEqual([50, 0]);

    captured = [];
    const garbage = await requestContacts('GET', `/${CONTACT_ID}/timeline?page=abc&limit=xyz`);
    expect(garbage.status).toBe(200);
    expect(queriesMatching(/UNION ALL/)[0].params.slice(-2)).toEqual([50, 0]);
  });

  it('caps a huge limit at 200 and 404s an unknown contact id without reading its timeline', async () => {
    const rows = buildInteractionRows(INTERACTION_FIXTURE_SIZE);
    installDb(timelineResponder({ alive: true, rows, countAfterDelete: false }));

    const huge = await requestContacts('GET', `/${CONTACT_ID}/timeline?limit=999999`);
    expect(huge.status).toBe(200);
    expect(queriesMatching(/UNION ALL/)[0].params.slice(-2)).toEqual([200, 0]);

    captured = [];
    installDb(timelineResponder({ alive: false, rows, countAfterDelete: false }));
    const missing = await requestContacts('GET', `/424242/timeline?page=2`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('联系人不存在');
    expect(queriesMatching(/UNION ALL/)).toHaveLength(0);
  });
});

describe('fixture 1 failure: contact deleted mid-timeline-pagination', () => {
  it('page 2 after the delete is a clean 404 (not a 500) and runs no data query', async () => {
    const state: TimelineState = { alive: true, rows: buildInteractionRows(INTERACTION_FIXTURE_SIZE), countAfterDelete: false };
    installDb(timelineResponder(state));

    const page1 = await requestContacts('GET', `/${CONTACT_ID}/timeline?page=1&limit=20`);
    expect(page1.status).toBe(200);
    expect((page1.body.data as unknown[]).length).toBe(20);

    // The contact is deleted between the two page requests.
    state.alive = false;
    captured = [];

    const page2 = await requestContacts('GET', `/${CONTACT_ID}/timeline?page=2&limit=20`);
    expect(page2.status).toBe(404);
    expect(page2.status).not.toBe(500);
    expect(page2.body.success).toBe(false);
    expect(page2.body.error).toBe('联系人不存在');
    expect(queriesMatching(/UNION ALL/)).toHaveLength(0);
    expect(queriesMatching(/::int AS count/)).toHaveLength(0);
  });

  it('a delete between the ownership probe and the page read yields a clean empty page', async () => {
    // Ownership probe succeeds, then the row is gone before COUNT/UNION run:
    // COUNT(*) = 0 and the page slice is empty -> 200 with an empty data array.
    installDb(timelineResponder({ alive: true, rows: [], countAfterDelete: true }));

    const { status, body } = await requestContacts('GET', `/${CONTACT_ID}/timeline?page=2&limit=20`);

    expect(status).toBe(200);
    expect(status).not.toBe(500);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.pagination).toEqual({ page: 2, limit: 20, total: 0, totalPages: 0 });
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — a habit with a 400-day history
// ---------------------------------------------------------------------------

const HABIT_HISTORY_DAYS = 400;
const OLDEST_DAY = shiftCalendarDays(TODAY, -(HABIT_HISTORY_DAYS - 1)) as string;

function habitRow(): Record<string, unknown> {
  return {
    id: HABIT_ID,
    user_id: USER.id,
    profile_id: null,
    name: '晨跑',
    icon: '🏃',
    target_per_period: 1,
    period: 'day',
    schedule_days: null,
    reminder_times: null,
    color: null,
    is_active: true,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  };
}

/** 400 consecutive daily logs ending TODAY; the OLDEST day carries count=99. */
function buildHabitHistory(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < HABIT_HISTORY_DAYS; i += 1) {
    const loggedOn = shiftCalendarDays(TODAY, -(HABIT_HISTORY_DAYS - 1 - i)) as string;
    rows.push({
      id: 1000 + i,
      habit_id: HABIT_ID,
      user_id: USER.id,
      logged_on: loggedOn,
      count: i === 0 ? 99 : 1,
      note: null,
      created_at: '2025-01-01T00:00:00.000Z',
    });
  }
  return rows;
}

function habitResponder(logs: Array<Record<string, unknown>>): Responder {
  return (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM habits WHERE id = $1 AND user_id = $2')) {
      return { rows: [habitRow()], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM habits WHERE user_id = $1')) {
      return { rows: [habitRow()], rowCount: 1 };
    }
    if (s.startsWith('SELECT id, habit_id, user_id, logged_on::text')) {
      // Two shapes: loadLogs(userId, habitId) and loadLogs(userId) (list page).
      const rows = params.length > 1 ? logs.filter((row) => row.habit_id === Number(params[1])) : logs;
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT habit_id, logged_on::text AS logged_on, SUM(count)')) {
      const from = String(params[1]);
      const to = String(params[2]);
      const grouped = new Map<string, { habit_id: number; logged_on: string; count: number }>();
      for (const row of logs) {
        const day = String(row.logged_on);
        if (day >= from && day <= to) {
          const key = `${String(row.habit_id)}#${day}`;
          const entry = grouped.get(key) ?? { habit_id: Number(row.habit_id), logged_on: day, count: 0 };
          entry.count += Number(row.count);
          grouped.set(key, entry);
        }
      }
      return { rows: [...grouped.values()], rowCount: grouped.size };
    }
    if (s.startsWith('SELECT timezone FROM user_configs')) {
      return { rows: [{ timezone: SHANGHAI }], rowCount: 1 };
    }
    return undefined;
  };
}

interface GridDay {
  date: string;
  count: number;
  met: boolean;
}

describe('fixture 2: habit with a 400-day history', () => {
  it('a 30-day grid window returns exactly the requested window (370 older days never leak)', async () => {
    const logs = buildHabitHistory();
    installDb(habitResponder(logs));

    const from = shiftCalendarDays(TODAY, -29) as string;
    const { status, body } = await requestHabits('GET', `/grid?from=${from}&to=${TODAY}`);

    expect(status).toBe(200);
    const grid = data(body) as { from: string; to: string; habits: Array<Record<string, unknown>> };
    expect(grid.from).toBe(from);
    expect(grid.to).toBe(TODAY);
    expect(grid.habits).toHaveLength(1);

    const days = grid.habits[0].days as GridDay[];
    expect(days).toHaveLength(30);
    expect(days.length).toBeLessThan(HABIT_HISTORY_DAYS);
    expect(days[0].date).toBe(from);
    expect(days[29].date).toBe(TODAY);
    expect(days.every((d) => d.date >= from && d.date <= TODAY)).toBe(true);
    // The 370 days outside the window — including the count=99 oldest day — never appear.
    expect(days.some((d) => d.date === OLDEST_DAY)).toBe(false);
    expect(days.reduce((sum, d) => sum + d.count, 0)).toBe(30);

    // Windowing happens in SQL (BETWEEN $2::date AND $3::date), not by slicing a full history.
    const [logsQuery] = queriesMatching(/FROM habit_logs/);
    expect(logsQuery.params).toEqual([USER.id, from, TODAY]);
    expect(logsQuery.sql.replace(/\s+/g, ' ')).toContain('logged_on BETWEEN $2::date AND $3::date');
  });

  it('the largest allowed window (399 days) still excludes the 400th day', async () => {
    const logs = buildHabitHistory();
    installDb(habitResponder(logs));

    const from = shiftCalendarDays(TODAY, -398) as string;
    const { status, body } = await requestHabits('GET', `/grid?from=${from}&to=${TODAY}`);

    expect(status).toBe(200);
    const grid = data(body) as { habits: Array<Record<string, unknown>> };
    const days = grid.habits[0].days as GridDay[];

    expect(days).toHaveLength(399);
    expect(days.length).not.toBe(HABIT_HISTORY_DAYS);
    expect(days[0].date).toBe(from);
    expect(days.at(-1)?.date).toBe(TODAY);
    expect(days.some((d) => d.date === OLDEST_DAY)).toBe(false);
    expect(days.reduce((sum, d) => sum + d.count, 0)).toBe(399);
  });

  it('rejects a window at/over 400 days and an inverted from>to range with 400', async () => {
    const logs = buildHabitHistory();
    installDb(habitResponder(logs));

    const tooLong = await requestHabits(
      'GET',
      `/grid?from=${shiftCalendarDays(TODAY, -400) as string}&to=${TODAY}`,
    );
    expect(tooLong.status).toBe(400);
    expect(String(tooLong.body.error)).toContain('400');

    const inverted = await requestHabits('GET', `/grid?from=${TODAY}&to=${shiftCalendarDays(TODAY, -5) as string}`);
    expect(inverted.status).toBe(400);

    const malformed = await requestHabits('GET', '/grid?from=nope&to=2026-06-07');
    expect(malformed.status).toBe(400);
  });

  it('computes a 400-day streak over the full history (streak + detail + list)', async () => {
    const logs = buildHabitHistory();
    installDb(habitResponder(logs));

    const streakRes = await requestHabits('GET', `/${HABIT_ID}/streak`);
    expect(streakRes.status).toBe(200);
    expect(data(streakRes.body)).toMatchObject({
      current: HABIT_HISTORY_DAYS,
      longest: HABIT_HISTORY_DAYS,
      targetMet: true,
      today: TODAY,
    });

    const detail = await requestHabits('GET', `/${HABIT_ID}`);
    expect(detail.status).toBe(200);
    expect((data(detail.body).streak as Record<string, unknown>).current).toBe(HABIT_HISTORY_DAYS);

    const list = await requestHabits('GET', '/');
    expect(list.status).toBe(200);
    const listHabits = data(list.body) as unknown as Array<Record<string, unknown>>;
    expect(listHabits).toHaveLength(1);
    expect((listHabits[0].streak as Record<string, unknown>).current).toBe(HABIT_HISTORY_DAYS);

    // The full-history read is the loadLogs query, scoped to the user+habit.
    const loads = queriesMatching(/logged_on::text/);
    for (const load of loads) {
      expect(load.params[0]).toBe(USER.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — cadence reminder across a cron retry (same clock)
// ---------------------------------------------------------------------------

function cadenceContactRow(): Record<string, unknown> {
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
    timezone: SHANGHAI,
    reminders_enabled: true,
  };
}

describe('fixture 3: cadence reminder must not fire twice across a cron retry', () => {
  it('the shared reminder job run twice with the same clock dispatches exactly one reminder', async () => {
    const claimedKeys = new Set<string>();
    const candidates = [cadenceContactRow()];

    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('FROM fixed_contacts fc')) {
        return { rows: candidates, rowCount: candidates.length };
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
      return undefined;
    });

    // First cron tick.
    await sendReminders();
    // "Cron retry": the same job, the same clock (getSyncedNow is fixed at NOW).
    await sendReminders();

    const cadenceSends = sendNotifications.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).type === 'contact_cadence',
    );
    expect(cadenceSends).toHaveLength(1);

    // The claim key = contact id + period start (day of last contact in user tz).
    expect([...claimedKeys]).toEqual(['7#contact:cadence#c7#p2026-05-15']);

    // The retry DID re-evaluate the contact (two claim attempts) and the second one lost.
    const claimAttempts = queriesMatching(/^INSERT INTO reminder_send_claims/);
    expect(claimAttempts).toHaveLength(2);
    expect(claimAttempts[0].params).toEqual([7, 'contact:cadence#c7#p2026-05-15']);
    expect(claimAttempts[1].params).toEqual([7, 'contact:cadence#c7#p2026-05-15']);

    // One inbox message with the 已记录联系 quick action, not two.
    const inboxWrites = queriesMatching(/^INSERT INTO inbox_messages/);
    const cadenceInbox = inboxWrites.filter((q) => String(q.params[1] ?? '').includes('关系维系提醒'));
    expect(cadenceInbox).toHaveLength(1);
  });
});
