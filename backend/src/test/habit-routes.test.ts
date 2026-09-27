import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dateStringInTimeZone, shiftCalendarDays } from '@timemark/shared/habit-schedule';

/**
 * Todo 64/65 acceptance for /api/habits:
 *
 * - every verb is auth-guarded (401 without a token)
 * - validation: count 0/negative, future log dates, out-of-range schedule_days,
 *   malformed reminder_times, unknown period, empty name -> 400
 * - same-day logging is an UPSERT: two POSTs -> one row with count=2, never two rows
 * - streak endpoint/detail use the shared pure function (Asia/Shanghai by default)
 * - grid returns only the requested window
 * - another user's habit is 404 and hostile names stay parameters
 *
 * The DB is mocked (no reachable Postgres here); the UNIQUE(habit_id, logged_on)
 * upsert is additionally proven against PGlite in the live harness.
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

import habitRoutes from '../routes/habits.js';

const USER = { id: 7, username: 'alice' };
const HABIT_ID = 5;

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];
/** Stateful habit_logs mirror: key `${habitId}#${loggedOn}` -> { id, count, note } */
let logRows: Map<string, { id: number; habit_id: number; user_id: number; logged_on: string; count: number; note: string | null }>;
let nextLogId: number;

function habitRowDb(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

let habitsTable: Record<string, unknown>[];

function installDb(): void {
  captured = [];
  habitsTable = [habitRowDb()];
  logRows = new Map();
  nextLogId = 100;
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT * FROM habits WHERE id =')) {
      const id = Number(params[0]);
      const userId = Number(params[1]);
      const row = habitsTable.find((h) => h.id === id && h.user_id === userId);
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT id FROM habits WHERE id =')) {
      const row = habitsTable.find((h) => h.id === Number(params[0]) && h.user_id === Number(params[1]));
      return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT timezone FROM user_configs')) {
      return { rows: [{ timezone: 'Asia/Shanghai' }], rowCount: 1 };
    }
    if (s.startsWith('SELECT id, habit_id, user_id, logged_on::text')) {
      const habitId = Number(params[1]);
      const rows = [...logRows.values()].filter((r) => r.habit_id === habitId);
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT * FROM habits WHERE user_id')) {
      return { rows: habitsTable, rowCount: habitsTable.length };
    }
    if (s.startsWith('SELECT habit_id, logged_on::text AS logged_on, SUM(count)')) {
      const from = String(params[1]);
      const to = String(params[2]);
      const grouped = new Map<string, { habit_id: number; logged_on: string; count: number }>();
      for (const row of logRows.values()) {
        if (row.logged_on >= from && row.logged_on <= to) {
          const key = `${row.habit_id}#${row.logged_on}`;
          const entry = grouped.get(key) ?? { habit_id: row.habit_id, logged_on: row.logged_on, count: 0 };
          entry.count += row.count;
          grouped.set(key, entry);
        }
      }
      return { rows: [...grouped.values()], rowCount: grouped.size };
    }
    if (s.startsWith('INSERT INTO habits')) {
      const created = habitRowDb({
        id: 900 + habitsTable.length,
        name: params[2],
        icon: params[3],
        target_per_period: params[4],
        period: params[5],
        schedule_days: params[6],
        reminder_times: params[7],
        color: params[8],
      });
      habitsTable.push(created);
      return { rows: [created], rowCount: 1 };
    }
    if (s.startsWith('UPDATE habits SET')) {
      const row = habitsTable.find((h) => h.id === Number(params[params.length - 2]));
      if (!row) return { rows: [], rowCount: 0 };
      // Apply each `column = $n` assignment from the SET clause to the row.
      const assignments = [...s.matchAll(/(\w+) = \$(\d+)/g)];
      for (const [, column, idx] of assignments) {
        row[column] = params[Number(idx) - 1];
      }
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM habits')) {
      const id = Number(params[0]);
      const userId = Number(params[1]);
      const before = habitsTable.length;
      habitsTable = habitsTable.filter((h) => !(h.id === id && h.user_id === userId));
      return { rows: before === habitsTable.length ? [] : [{ id }], rowCount: before - habitsTable.length };
    }
    if (s.startsWith('INSERT INTO habit_logs')) {
      const habitId = Number(params[0]);
      const userId = Number(params[1]);
      const loggedOn = String(params[2]);
      const count = Number(params[3]);
      const note = params[4] == null ? null : String(params[4]);
      const key = `${habitId}#${loggedOn}`;
      const existing = logRows.get(key);
      let row;
      if (existing) {
        existing.count += count;
        existing.note = note ?? existing.note;
        row = existing;
      } else {
        row = { id: nextLogId++, habit_id: habitId, user_id: userId, logged_on: loggedOn, count, note };
        logRows.set(key, row);
      }
      return { rows: [{ ...row }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function request(method: string, path: string, body?: unknown) {
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

const SHANGHAI = 'Asia/Shanghai';
const TODAY = dateStringInTimeZone(new Date(), SHANGHAI);
const YESTERDAY = shiftCalendarDays(TODAY, -1) as string;
const TOMORROW = shiftCalendarDays(TODAY, 1) as string;

beforeEach(() => {
  authState.user = { ...USER };
  installDb();
});

describe('habits API - auth guard', () => {
  it('returns 401 for every verb without a token', async () => {
    authState.user = null;
    const cases: Array<[string, string, unknown?]> = [
      ['GET', '/'],
      ['GET', '/grid?from=2026-06-01&to=2026-06-07'],
      ['POST', '/', { name: '晨跑' }],
      ['GET', `/${HABIT_ID}`],
      ['GET', `/${HABIT_ID}/streak`],
      ['POST', `/${HABIT_ID}/log`, { count: 1 }],
      ['PATCH', `/${HABIT_ID}`, { name: '晚跑' }],
      ['DELETE', `/${HABIT_ID}`],
    ];
    for (const [method, path, body] of cases) {
      const { status, body: json } = await request(method, path, body);
      expect(status, `${method} ${path}`).toBe(401);
      expect(json.error).toBe('Unauthorized');
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('habits API - create validation and storage', () => {
  it('creates a habit and normalizes schedule/reminder arrays', async () => {
    const { status, body } = await request('POST', '/', {
      name: '晨跑',
      icon: '🏃',
      targetPerPeriod: 1,
      period: 'day',
      scheduleDays: [1, 3, 5, 3],
      reminderTimes: ['08:00', '08:00', '20:00'],
    });
    expect(status).toBe(201);
    expect(data(body).name).toBe('晨跑');

    const insert = captured.find((q) => q.sql.replace(/\s+/g, ' ').startsWith('INSERT INTO habits'));
    expect(insert).toBeDefined();
    expect(insert!.params[6]).toEqual([1, 3, 5]);
    expect(insert!.params[7]).toEqual(['08:00', '20:00']);
  });

  it('rejects malformed create payloads with 400', async () => {
    const cases: unknown[] = [
      { name: '' },
      { name: 'x', period: 'month' },
      { name: 'x', scheduleDays: [7] },
      { name: 'x', scheduleDays: [-1] },
      { name: 'x', reminderTimes: ['25:00'] },
      { name: 'x', reminderTimes: ['8:00'] },
      { name: 'x', targetPerPeriod: 0 },
      { name: 'x', targetPerPeriod: 1.5 },
    ];
    for (const payload of cases) {
      const { status } = await request('POST', '/', payload);
      expect(status, JSON.stringify(payload)).toBe(400);
    }
  });

  it('keeps a hostile habit name only as a parameter', async () => {
    const hostile = `'; DROP TABLE habits;-- <script>x</script>`;
    const { status } = await request('POST', '/', { name: hostile });
    expect(status).toBe(201);
    const insert = captured.find((q) => q.sql.replace(/\s+/g, ' ').startsWith('INSERT INTO habits'));
    expect(insert!.params[2]).toBe(hostile);
    for (const q of captured) {
      expect(q.sql).not.toContain('DROP TABLE habits');
      expect(q.sql).not.toContain('<script>');
    }
  });
});

describe('habits API - logging (same-day upsert)', () => {
  it('upserts to count=2 on the second log and never creates a second row', async () => {
    const first = await request('POST', `/${HABIT_ID}/log`, {});
    expect(first.status).toBe(200);
    expect(data(first.body).count).toBe(1);

    const second = await request('POST', `/${HABIT_ID}/log`, { count: 1, note: '再来一次' });
    expect(second.status).toBe(200);
    expect(data(second.body).count).toBe(2);
    expect(data(second.body).note).toBe('再来一次');

    expect(logRows.size).toBe(1);
    const upsert = captured.find((q) => q.sql.includes('ON CONFLICT (habit_id, logged_on)'));
    expect(upsert).toBeDefined();
    expect(upsert!.sql).toContain('count = habit_logs.count + EXCLUDED.count');
  });

  it('rejects count = 0 and negative counts with 400', async () => {
    for (const count of [0, -1, -100]) {
      const { status } = await request('POST', `/${HABIT_ID}/log`, { count });
      expect(status, `count=${count}`).toBe(400);
    }
    expect(logRows.size).toBe(0);
  });

  it('rejects a future logged_on date with 400', async () => {
    const { status, body } = await request('POST', `/${HABIT_ID}/log`, { loggedOn: TOMORROW });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('未来');
    expect(logRows.size).toBe(0);
  });

  it('accepts yesterday and accumulates onto an existing day', async () => {
    const first = await request('POST', `/${HABIT_ID}/log`, { loggedOn: YESTERDAY, count: 2 });
    expect(first.status).toBe(200);
    const second = await request('POST', `/${HABIT_ID}/log`, { loggedOn: YESTERDAY, count: 3 });
    expect(data(second.body).count).toBe(5);
    expect(logRows.size).toBe(1);
  });

  it('404s for another user / unknown habit and 400 for an invalid id', async () => {
    habitsTable = [];
    const missing = await request('POST', `/${HABIT_ID}/log`, {});
    expect(missing.status).toBe(404);
    const invalid = await request('POST', '/abc/log', {});
    expect(invalid.status).toBe(400);
  });
});

describe('habits API - streak and grid', () => {
  it('returns the current streak from the shared pure function', async () => {
    // Logs for today, yesterday and the day before -> streak 3 (today met).
    for (const day of [TODAY, YESTERDAY, shiftCalendarDays(TODAY, -2)]) {
      const res = await request('POST', `/${HABIT_ID}/log`, { loggedOn: day });
      expect(res.status).toBe(200);
    }

    const { status, body } = await request('GET', `/${HABIT_ID}/streak`);
    expect(status).toBe(200);
    expect(data(body)).toMatchObject({ current: 3, longest: 3, targetMet: true, today: TODAY });

    const detail = await request('GET', `/${HABIT_ID}`);
    expect(detail.status).toBe(200);
    expect((data(detail.body).streak as Record<string, unknown>).current).toBe(3);
  });

  it('returns only the requested grid window with per-day counts', async () => {
    await request('POST', `/${HABIT_ID}/log`, { loggedOn: TODAY, count: 2 });
    await request('POST', `/${HABIT_ID}/log`, { loggedOn: YESTERDAY });

    const from = shiftCalendarDays(TODAY, -2) as string;
    const { status, body } = await request('GET', `/grid?from=${from}&to=${TODAY}`);
    expect(status).toBe(200);
    const grid = data(body) as { from: string; to: string; habits: Array<Record<string, unknown>> };
    expect(grid.from).toBe(from);
    expect(grid.to).toBe(TODAY);
    expect(grid.habits).toHaveLength(1);
    const days = grid.habits[0].days as Array<Record<string, unknown>>;
    expect(days.map((d) => d.date)).toEqual([from, YESTERDAY, TODAY]);
    expect(days[0]).toMatchObject({ count: 0, met: false });
    expect(days[1]).toMatchObject({ count: 1, met: true });
    expect(days[2]).toMatchObject({ count: 2, met: true });
    // No data outside the requested window is returned.
    expect(days.every((d) => String(d.date) >= from && String(d.date) <= TODAY)).toBe(true);
  });

  it('rejects malformed or oversized grid ranges with 400', async () => {
    for (const path of [
      '/grid',
      '/grid?from=2026-06-01',
      '/grid?from=nope&to=2026-06-07',
      '/grid?from=2027-01-01&to=2026-01-01',
    ]) {
      const { status } = await request('GET', path);
      expect(status, path).toBe(400);
    }
  });
});

describe('habits API - update and delete', () => {
  it('updates cadence-style fields and returns the streak payload', async () => {
    const { status, body } = await request('PATCH', `/${HABIT_ID}`, {
      name: '夜跑',
      period: 'week',
      targetPerPeriod: 3,
      scheduleDays: [1, 3, 5],
      reminderTimes: ['20:30'],
      isActive: false,
    });
    expect(status).toBe(200);
    expect(data(body).name).toBe('夜跑');
    const update = captured.find((q) => q.sql.replace(/\s+/g, ' ').startsWith('UPDATE habits SET'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('schedule_days = $');
  });

  it('404s update/delete for another user and deletes for the owner', async () => {
    const update = await request('PATCH', '/999', { name: 'x' });
    expect(update.status).toBe(404);
    const del = await request('DELETE', '/999');
    expect(del.status).toBe(404);
    const own = await request('DELETE', `/${HABIT_ID}`);
    expect(own.status).toBe(200);
    expect(habitsTable).toHaveLength(0);
  });
});
