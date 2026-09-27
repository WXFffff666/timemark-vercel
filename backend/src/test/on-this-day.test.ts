import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 82 acceptance (backend half): `GET /api/stats/on-this-day`.
 *
 * The endpoint is the read-only, user-scoped source for the dashboard
 * 「时光回顾 / N 年前的今天」card. This suite pins:
 * - auth guard (401 without a token, nothing touches the DB before auth)
 * - exact month-day matching across previous years only (this year + future
 *   rows are never memory; "future occurred_at" is excluded by construction)
 * - leap-day anniversaries: a Feb-29 event surfaces on Feb-28 in a non-leap
 *   year (and on Feb-29 itself)
 * - user scoping: another user's rows never appear
 * - empty history returns `items: []` (the UI renders nothing)
 * - read-only: no INSERT/UPDATE/DELETE is ever issued
 * - long titles / summaries round-trip verbatim (500 chars)
 *
 * The DB layer is mocked; the SQL shapes are asserted so a mutant that drops
 * the user predicate, the year guard or the month-day predicate fails here.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../jobs/tasks.js', () => ({ sendReminders: vi.fn() }));
vi.mock('../services/expiry.service.js', () => ({
  getExpirySummary: vi.fn(),
  getExpiryCosts: vi.fn(),
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

import statsRoutes from '../routes/stats.js';
import { memoryMonthDays, parseYmd, yearsAgoValue } from '../routes/stats.js';

const USER = { id: 7, username: 'alice' };
const TODAY = '2026-09-28';

interface Captured {
  sql: string;
  params: unknown[];
}

type Row = Record<string, unknown>;

let captured: Captured[];
let events: Row[];
let interactions: Row[];

function installDb(): void {
  captured = [];
  events = [];
  interactions = [];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT TO_CHAR(CURRENT_DATE')) {
      return { rows: [{ today: TODAY }], rowCount: 1 };
    }

    if (s.includes('FROM events')) {
      const [userId, monthDays, refYear] = params as [number, string[], number];
      const rows = events
        .filter((e) => e.user_id === userId)
        .filter((e) => monthDays.includes(String(e.date).slice(5, 10)))
        .filter((e) => Number(String(e.date).slice(0, 4)) < refYear)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id))
        .slice(0, Number(params[3] ?? 50))
        .map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          occurred_on: String(e.date).slice(0, 10),
          occurred_year: Number(String(e.date).slice(0, 4)),
        }));
      return { rows, rowCount: rows.length };
    }

    if (s.includes('FROM interactions')) {
      const [userId, monthDays, refYear] = params as [number, string[], number];
      const rows = interactions
        .filter((i) => i.user_id === userId)
        .filter((i) => monthDays.includes(String(i.occurred_at).slice(5, 10)))
        .filter((i) => Number(String(i.occurred_at).slice(0, 4)) < refYear)
        .sort(
          (a, b) =>
            String(b.occurred_at).localeCompare(String(a.occurred_at)) || Number(b.id) - Number(a.id),
        )
        .slice(0, Number(params[3] ?? 50))
        .map((i) => ({
          id: i.id,
          kind: i.kind,
          summary: i.summary,
          contact_id: i.contact_id,
          contact_name: i.contact_name ?? null,
          occurred_on: String(i.occurred_at).slice(0, 10),
          occurred_year: Number(String(i.occurred_at).slice(0, 4)),
        }));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`on-this-day test fake: unexpected query: ${s}`);
  });
}

async function request(path: string) {
  const res = await statsRoutes.request(path, { method: 'GET' });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as { success?: boolean; data?: { date?: string; items?: Row[] } } };
}

function items(body: { data?: { items?: Row[] } }): Row[] {
  return body.data?.items ?? [];
}

beforeEach(() => {
  authState.user = { ...USER };
  installDb();
});

describe('pure helpers', () => {
  it('parseYmd rejects impossible calendar days and accepts real ones', () => {
    expect(parseYmd('2026-09-28')).toEqual({ year: 2026, month: 9, day: 28 });
    expect(parseYmd('2026-02-29')).toBeNull(); // 2026 is not a leap year
    expect(parseYmd('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseYmd('2026-13-01')).toBeNull();
    expect(parseYmd('2026-2-1')).toBeNull();
    expect(parseYmd('nope')).toBeNull();
    expect(parseYmd(null)).toBeNull();
  });

  it('memoryMonthDays adds Feb-29 only on Feb-28 in a non-leap year', () => {
    expect(memoryMonthDays({ year: 2026, month: 2, day: 28 })).toEqual(['02-28', '02-29']);
    expect(memoryMonthDays({ year: 2024, month: 2, day: 28 })).toEqual(['02-28']);
    expect(memoryMonthDays({ year: 2026, month: 2, day: 29 })).toEqual(['02-29']);
    expect(memoryMonthDays({ year: 2026, month: 9, day: 28 })).toEqual(['09-28']);
  });

  it('yearsAgoValue never goes negative for future years', () => {
    expect(yearsAgoValue(2026, 2023)).toBe(3);
    expect(yearsAgoValue(2026, 2026)).toBe(0);
    expect(yearsAgoValue(2026, 2030)).toBe(0);
  });
});

describe('GET /api/stats/on-this-day', () => {
  it('requires auth and touches nothing before it', async () => {
    authState.user = null;
    const { status } = await request('/on-this-day?date=2026-09-28');
    expect(status).toBe(401);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('lists previous-years events and interactions on the same month-day, newest first', async () => {
    events = [
      { id: 1, user_id: USER.id, name: '三年前的事', type: 'other', date: '2023-09-28' },
      { id: 2, user_id: USER.id, name: '两年前的事', type: 'other', date: '2024-09-28' },
      { id: 3, user_id: USER.id, name: '今年的今天', type: 'other', date: '2026-09-28' },
      { id: 4, user_id: USER.id, name: '别的一天', type: 'other', date: '2023-09-27' },
      { id: 5, user_id: USER.id, name: '未来某年', type: 'other', date: '2030-09-28' },
      { id: 99, user_id: 999, name: '别人的事', type: 'other', date: '2023-09-28' },
    ];
    interactions = [
      {
        id: 11,
        user_id: USER.id,
        contact_id: 1,
        contact_name: '妈妈',
        kind: 'call',
        summary: '打电话',
        occurred_at: '2022-09-28T10:00:00Z',
      },
      {
        id: 12,
        user_id: USER.id,
        contact_id: 1,
        contact_name: '妈妈',
        kind: 'call',
        summary: '未来通话',
        occurred_at: '2031-09-28T10:00:00Z',
      },
      {
        id: 13,
        user_id: 999,
        contact_id: 2,
        contact_name: '别人的联系人',
        kind: 'call',
        summary: '别人的记录',
        occurred_at: '2022-09-28T10:00:00Z',
      },
    ];

    const { status, body } = await request('/on-this-day?date=2026-09-28');
    expect(status).toBe(200);
    const rows = items(body);
    // 3 previous-year rows: 2024 event, 2023 event, 2022 interaction. This-year,
    // future and other-user rows are all excluded.
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual(['event:2', 'event:1', 'interaction:11']);
    expect(rows.find((r) => r.id === 2)?.yearsAgo).toBe(2);
    expect(rows.find((r) => r.id === 1)?.yearsAgo).toBe(3);
    expect(rows.find((r) => r.id === 11)?.yearsAgo).toBe(4);
    expect(rows.find((r) => r.id === 11)?.sourcePath).toBe('/contacts');

    // The user predicate and the year guard are both bound, not optional.
    const evq = captured.find((q) => q.sql.includes('FROM events'));
    expect(evq?.params[0]).toBe(USER.id);
    expect(evq?.params[1]).toEqual(['09-28']);
    expect(evq?.params[2]).toBe(2026);
    expect(evq?.sql).toContain('user_id = $1');
    expect(evq?.sql).toContain('EXTRACT(YEAR FROM date)::int < $3');

    // Read-only: no writes anywhere in the request.
    expect(
      captured.filter((q) => /^(?:INSERT|UPDATE|DELETE)\b/i.test(q.sql.trim())),
    ).toHaveLength(0);
  });

  it('surfaces a Feb-29 anniversary on Feb-28 of a non-leap year', async () => {
    events = [{ id: 1, user_id: USER.id, name: '闰日出生', type: 'birthday', date: '2024-02-29' }];
    const { status, body } = await request('/on-this-day?date=2026-02-28');
    expect(status).toBe(200);
    const rows = items(body);
    expect(rows).toHaveLength(1);
    expect(rows[0].yearsAgo).toBe(2);
    const evq = captured.find((q) => q.sql.includes('FROM events'));
    expect(evq?.params[1]).toEqual(['02-28', '02-29']);
  });

  it('returns items:[] (no shell) for an account with no history', async () => {
    const { status, body } = await request('/on-this-day?date=2026-09-28');
    expect(status).toBe(200);
    expect(body.data?.items).toEqual([]);
    expect(body.data?.date).toBe('2026-09-28');
  });

  it('defaults to the database current date when ?date= is omitted', async () => {
    const { status, body } = await request('/on-this-day');
    expect(status).toBe(200);
    expect(body.data?.date).toBe(TODAY);
    const evq = captured.find((q) => q.sql.includes('FROM events'));
    expect(evq?.params[1]).toEqual(['09-28']);
  });

  it('rejects a malformed date with 400 and never queries the tables', async () => {
    for (const bad of ['2026-02-30', '2026-13-01', 'yesterday', '2026/09/28', '']) {
      const { status } = await request(`/on-this-day?date=${encodeURIComponent(bad)}`);
      expect(status, bad).toBe(400);
    }
    expect(captured.some((q) => q.sql.includes('FROM events'))).toBe(false);
  });

  it('round-trips a 500-char title and summary verbatim', async () => {
    const long = '回'.repeat(500);
    events = [{ id: 1, user_id: USER.id, name: long, type: 'other', date: '2023-09-28' }];
    interactions = [
      {
        id: 2,
        user_id: USER.id,
        contact_id: 1,
        contact_name: '朋友',
        kind: 'meal',
        summary: long,
        occurred_at: '2022-09-28T10:00:00Z',
      },
    ];
    const { status, body } = await request('/on-this-day?date=2026-09-28');
    expect(status).toBe(200);
    const rows = items(body);
    expect(rows.find((r) => r.kind === 'event')?.title).toHaveLength(500);
    expect(rows.find((r) => r.kind === 'interaction')?.title).toHaveLength(500);
  });
});
