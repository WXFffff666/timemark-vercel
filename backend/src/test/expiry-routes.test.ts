import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 45 acceptance: /api/expiry CRUD + upcoming/overdue + renew.
 *
 * - every verb is auth-guarded (401 without a token)
 * - every query is user-scoped; deleting/renewing another user's item is 404 (not 403)
 * - pagination shape matches the existing events API convention
 * - renew with cycle='monthly' from 2026-01-31 lands on a valid month end (2026-02-28,
 *   never 2026-02-31); renew on cycle='once' is a 400
 *
 * The DB layer is mocked (no reachable Postgres in this environment) and the auth
 * middleware delegates to the real one when no user is seeded, so the 401 contract
 * is exercised for real.
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

import expiryRoutes from '../routes/expiry.js';

const USER = { id: 7, username: 'alice' };
const OTHER_USER = { id: 99, username: 'bob' };

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];

type Responder = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number | null } | undefined;

/** Capture every query and answer through the given responder (default: empty result). */
function installDb(responder: Responder = () => undefined): void {
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

function itemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    user_id: USER.id,
    profile_id: null,
    kind: 'subscription',
    title: 'Netflix 会员',
    vendor: 'Netflix',
    amount_cents: '1999',
    currency: 'CNY',
    cycle: 'monthly',
    cycle_days: null,
    start_date: '2025-01-31',
    next_due_date: '2026-01-31',
    auto_renew: true,
    notes: null,
    tags: [],
    reminder_config: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await expiryRoutes.request(path, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

beforeEach(() => {
  authState.user = { ...USER };
  installDb();
});

describe('GET /api/expiry — auth guard, scoping and pagination', () => {
  it('returns 401 for every expiry verb without a token', async () => {
    authState.user = null;
    const cases: Array<[string, string]> = [
      ['GET', '/'],
      ['GET', '/upcoming'],
      ['GET', '/overdue'],
      ['GET', '/costs'],
      ['POST', '/'],
      ['PATCH', '/1'],
      ['DELETE', '/1'],
      ['POST', '/1/renew'],
    ];
    for (const [method, path] of cases) {
      const { status, body } = await request(method, path);
      expect(status, `${method} ${path}`).toBe(401);
      expect(body.error).toBe('Unauthorized');
    }
    // Nothing reached the DB before auth.
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('returns { data, pagination } in the events API shape and scopes by user', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('COUNT(*)::int AS count FROM expiry_items')) {
        return { rows: [{ count: 2 }], rowCount: 1 };
      }
      if (s.startsWith('SELECT * FROM expiry_items')) {
        return { rows: [itemRow()], rowCount: 1 };
      }
      return undefined;
    });

    const { status, body } = await request('GET', '/?page=2&limit=1');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });

    const listQueries = queriesMatching(/FROM expiry_items/);
    expect(listQueries.length).toBe(2);
    for (const q of listQueries) {
      expect(q.sql).toContain('user_id = $1');
      expect(q.params[0]).toBe(USER.id);
    }
    // LIMIT/OFFSET follow the filter parameters.
    const list = listQueries.find((q) => q.sql.includes('SELECT *'));
    expect(list?.params.slice(-2)).toEqual([1, 1]);
  });

  it('passes kind/active/from/to/q through as scoped predicates', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('COUNT(*)::int AS count FROM expiry_items')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (s.startsWith('SELECT * FROM expiry_items')) return { rows: [], rowCount: 0 };
      return undefined;
    });

    const { status } = await request(
      'GET',
      '/?kind=bill&active=true&from=2026-01-01&to=2026-12-31&q=net',
    );
    expect(status).toBe(200);

    const list = queriesMatching(/SELECT \* FROM expiry_items/).at(-1);
    expect(list).toBeDefined();
    const sql = list!.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('kind = $2');
    expect(sql).toContain('is_active = $3');
    expect(sql).toContain('next_due_date >= $4::date');
    expect(sql).toContain('next_due_date <= $5::date');
    expect(sql).toContain('ILIKE $6');
    expect(list!.params).toEqual([
      USER.id,
      'bill',
      true,
      '2026-01-01',
      '2026-12-31',
      '%net%',
      50,
      0,
    ]);
  });

  it('rejects malformed filters with 400', async () => {
    expect((await request('GET', '/?kind=nonsense')).status).toBe(400);
    expect((await request('GET', '/?active=maybe')).status).toBe(400);
    expect((await request('GET', '/?from=2026/01/01')).status).toBe(400);
    expect((await request('GET', '/?to=oops')).status).toBe(400);
  });

  it('clamps upcoming days and scopes by user', async () => {
    installDb((sql) => {
      if (sql.includes('FROM expiry_items')) return { rows: [itemRow()], rowCount: 1 };
      return undefined;
    });
    const { status, body } = await request('GET', '/upcoming?days=7');
    expect(status).toBe(200);
    expect(body.days).toBe(7);
    const q = queriesMatching(/next_due_date >= CURRENT_DATE/).at(-1);
    expect(q?.sql).toContain('user_id = $1');
    expect(q?.params).toEqual([USER.id, 7]);

    const clamped = await request('GET', '/upcoming?days=99999');
    expect(clamped.body.days).toBe(365);
  });

  it('lists overdue items scoped by user', async () => {
    installDb((sql) => {
      if (sql.includes('next_due_date < CURRENT_DATE')) return { rows: [itemRow({ next_due_date: '2025-12-01' })], rowCount: 1 };
      return undefined;
    });
    const { status, body } = await request('GET', '/overdue');
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    const q = queriesMatching(/next_due_date < CURRENT_DATE/).at(-1);
    expect(q?.sql).toContain('user_id = $1');
    expect(q?.params).toEqual([USER.id]);
  });
});

describe('POST /api/expiry — validation and create', () => {
  it('creates an item scoped to the user and returns 201', async () => {
    installDb((sql) => {
      if (/^INSERT INTO expiry_items/.test(sql.replace(/\s+/g, ' ').trim())) {
        return { rows: [itemRow({ id: 42 })], rowCount: 1 };
      }
      return undefined;
    });

    const { status, body } = await request('POST', '/', {
      kind: 'subscription',
      title: 'Netflix 会员',
      amountCents: 1999,
      currency: 'cny',
      cycle: 'monthly',
      nextDueDate: '2026-02-01',
      startDate: '2026-01-01',
      tags: ['video'],
      reminderConfig: { daysBeforeList: [7, 1] },
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);

    const insert = queriesMatching(/INSERT INTO expiry_items/).at(-1);
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe(USER.id);
    // currency is normalised to upper case before persistence
    expect(insert!.params).toContain('CNY');
    expect(insert!.params).toContain(1999);
    expect(insert!.params).toContain('2026-02-01');
  });

  it('rejects a negative amount, an unknown kind and due-before-start with 400', async () => {
    const base = { kind: 'subscription', title: 'X', nextDueDate: '2026-02-01' };
    for (const payload of [
      { ...base, amountCents: -1 },
      { ...base, kind: 'nonsense' },
      { ...base, startDate: '2026-03-01', nextDueDate: '2026-02-28' },
    ]) {
      const { status, body } = await request('POST', '/', payload);
      expect(status, JSON.stringify(payload)).toBe(400);
      expect(body.success).toBe(false);
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/expiry/:id — user scoping', () => {
  it('updates only the owner\'s row', async () => {
    installDb((sql) => {
      if (sql.includes('UPDATE expiry_items')) {
        return { rows: [itemRow({ title: '新名称' })], rowCount: 1 };
      }
      return undefined;
    });

    const { status, body } = await request('PATCH', '/1', { title: '新名称' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const update = queriesMatching(/UPDATE expiry_items/).at(-1);
    expect(update?.sql).toContain('WHERE id = $1 AND user_id = $2');
    expect(update?.params.slice(0, 2)).toEqual([1, USER.id]);
  });

  it('returns 404 (not 403) for another user\'s item', async () => {
    authState.user = { ...OTHER_USER };
    installDb((sql) => (sql.includes('UPDATE expiry_items') ? { rows: [], rowCount: 0 } : undefined));

    const { status, body } = await request('PATCH', '/1', { title: 'steal' });
    expect(status).toBe(404);
    expect(body.error).toBe('到期项不存在');
  });

  it('rejects a malformed patch with 400', async () => {
    expect((await request('PATCH', '/1', { amountCents: -5 })).status).toBe(400);
    expect((await request('PATCH', '/abc', { title: 'x' })).status).toBe(400);
  });
});

describe('DELETE /api/expiry/:id — 404 for foreign ids', () => {
  it('deletes the owner\'s row', async () => {
    installDb((sql) => (sql.includes('DELETE FROM expiry_items') ? { rows: [], rowCount: 1 } : undefined));
    const { status } = await request('DELETE', '/5');
    expect(status).toBe(200);
    const del = queriesMatching(/DELETE FROM expiry_items/).at(-1);
    expect(del?.sql).toBe('DELETE FROM expiry_items WHERE id = $1 AND user_id = $2');
    expect(del?.params).toEqual([5, USER.id]);
  });

  it('returns 404 (not 403) when the row belongs to someone else', async () => {
    authState.user = { ...OTHER_USER };
    installDb((sql) => (sql.includes('DELETE FROM expiry_items') ? { rows: [], rowCount: 0 } : undefined));
    const { status, body } = await request('DELETE', '/5');
    expect(status).toBe(404);
    expect(body.error).toBe('到期项不存在');
  });
});

describe('POST /api/expiry/:id/renew — month-end and history', () => {
  it('advances monthly 2026-01-31 to the valid month end 2026-02-28', async () => {
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM expiry_items WHERE id = $1 AND user_id = $2')) {
        return { rows: [itemRow({ next_due_date: '2026-01-31', cycle: 'monthly' })], rowCount: 1 };
      }
      if (s.startsWith('UPDATE expiry_items')) {
        return { rows: [itemRow({ next_due_date: String(params[0]), cycle: 'monthly' })], rowCount: 1 };
      }
      if (s.startsWith('INSERT INTO expiry_history')) {
        return {
          rows: [{
            id: 1,
            item_id: params[0],
            action: 'renew',
            from_date: params[1],
            to_date: params[2],
            amount_cents: params[3],
            created_at: '2026-01-31T00:00:00.000Z',
          }],
          rowCount: 1,
        };
      }
      return undefined;
    });

    const { status, body } = await request('POST', '/1/renew');
    expect(status).toBe(200);

    const update = queriesMatching(/UPDATE expiry_items/).at(-1);
    expect(update?.params[0]).toBe('2026-02-28');
    expect(update?.params[0]).not.toBe('2026-02-31');

    const history = queriesMatching(/INSERT INTO expiry_history/).at(-1);
    expect(history?.params.slice(0, 4)).toEqual([1, '2026-01-31', '2026-02-28', 1999]);

    const data = body.data as Record<string, unknown>;
    expect(data.next_due_date).toBe('2026-02-28');
    expect((body.history as Record<string, unknown>).action).toBe('renew');
  });

  it('clamps quarterly and leap-year-yield dates to real month ends', async () => {
    const cases: Array<{ from: string; cycle: string; expected: string }> = [
      { from: '2026-01-31', cycle: 'quarterly', expected: '2026-04-30' },
      { from: '2024-02-29', cycle: 'yearly', expected: '2025-02-28' },
      { from: '2026-01-31', cycle: 'yearly', expected: '2027-01-31' },
    ];
    for (const c of cases) {
      installDb((sql, params) => {
        const s = sql.replace(/\s+/g, ' ');
        if (s.includes('FROM expiry_items WHERE id = $1 AND user_id = $2')) {
          return { rows: [itemRow({ next_due_date: c.from, cycle: c.cycle })], rowCount: 1 };
        }
        if (s.startsWith('UPDATE expiry_items')) {
          return { rows: [itemRow({ next_due_date: String(params[0]), cycle: c.cycle })], rowCount: 1 };
        }
        if (s.startsWith('INSERT INTO expiry_history')) {
          return { rows: [{ id: 1, item_id: 1, action: 'renew', created_at: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
        }
        return undefined;
      });
      const { status } = await request('POST', '/1/renew');
      expect(status, `${c.cycle} from ${c.from}`).toBe(200);
      expect(queriesMatching(/UPDATE expiry_items/).at(-1)?.params[0]).toBe(c.expected);
    }
  });

  it('advances a custom cycle by cycle_days', async () => {
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM expiry_items WHERE id = $1 AND user_id = $2')) {
        return { rows: [itemRow({ next_due_date: '2026-01-01', cycle: 'custom', cycle_days: 45 })], rowCount: 1 };
      }
      if (s.startsWith('UPDATE expiry_items')) {
        return { rows: [itemRow({ next_due_date: String(params[0]), cycle: 'custom', cycle_days: 45 })], rowCount: 1 };
      }
      if (s.startsWith('INSERT INTO expiry_history')) {
        return { rows: [{ id: 1, item_id: 1, action: 'renew', created_at: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
      }
      return undefined;
    });

    const { status } = await request('POST', '/1/renew');
    expect(status).toBe(200);
    expect(queriesMatching(/UPDATE expiry_items/).at(-1)?.params[0]).toBe('2026-02-15');
  });

  it('rejects renew on cycle=once with a 400 explaining one-off items cannot renew', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM expiry_items WHERE id = $1 AND user_id = $2')) {
        return { rows: [itemRow({ next_due_date: '2026-01-31', cycle: 'once' })], rowCount: 1 };
      }
      return undefined;
    });

    const { status, body } = await request('POST', '/1/renew');
    expect(status).toBe(400);
    expect(String(body.error)).toContain('一次性');
    expect(String(body.error)).toContain('不能续期');
    // No reschedule and no audit row for a rejected renew.
    expect(queriesMatching(/UPDATE expiry_items/)).toHaveLength(0);
    expect(queriesMatching(/INSERT INTO expiry_history/)).toHaveLength(0);
  });

  it('returns 404 (not 403) when renewing another user\'s item', async () => {
    authState.user = { ...OTHER_USER };
    installDb(() => undefined);
    const { status, body } = await request('POST', '/1/renew');
    expect(status).toBe(404);
    expect(body.error).toBe('到期项不存在');
    expect(queriesMatching(/UPDATE expiry_items/)).toHaveLength(0);
  });
});

describe('user scoping proof', () => {
  it('every SELECT/UPDATE/DELETE against expiry_items carries a user_id predicate', async () => {
    // Exercise all verbs with benign responses.
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('COUNT(*)::int AS count FROM expiry_items')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (s.includes('FROM expiry_items WHERE id = $1 AND user_id = $2')) return { rows: [itemRow()], rowCount: 1 };
      if (s.startsWith('SELECT * FROM expiry_items')) return { rows: [], rowCount: 0 };
      if (s.startsWith('INSERT INTO expiry_items')) return { rows: [itemRow()], rowCount: 1 };
      if (s.startsWith('UPDATE expiry_items')) return { rows: [itemRow()], rowCount: 1 };
      if (s.startsWith('DELETE FROM expiry_items')) return { rows: [], rowCount: 1 };
      if (s.startsWith('INSERT INTO expiry_history')) {
        return { rows: [{ id: 1, item_id: 1, action: 'renew', created_at: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
      }
      return undefined;
    });

    await request('GET', '/');
    await request('GET', '/upcoming');
    await request('GET', '/overdue');
    await request('GET', '/costs');
    await request('POST', '/', { kind: 'bill', title: 'X', nextDueDate: '2026-02-01' });
    await request('PATCH', '/1', { title: 'Y' });
    await request('DELETE', '/1');
    await request('POST', '/1/renew');

    const scopedStatements = captured.filter((q) => {
      const s = q.sql.replace(/\s+/g, ' ').trim();
      return /^(SELECT|UPDATE|DELETE)/.test(s) && s.includes('expiry_items');
    });
    expect(scopedStatements.length).toBeGreaterThanOrEqual(8);
    for (const q of scopedStatements) {
      expect(q.sql, `unscoped statement: ${q.sql}`).toContain('user_id = $');
      expect(q.params).toContain(USER.id);
    }
  });
});
