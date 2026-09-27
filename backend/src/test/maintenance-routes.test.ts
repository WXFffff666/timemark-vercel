import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 50 acceptance: /api/maintenance CRUD + POST /:id/log rescheduling.
 *
 * - every verb is auth-guarded (401 without a token); every query is user-scoped
 * - a 180-day / 10000km plan reschedules to done_at + 180d and usage_at + 10000
 * - a second log before the due date is allowed and reschedules from the LATEST log
 * - a plan with NEITHER interval is rejected with a clear validation error (create),
 *   and a PATCH that would null both existing intervals is rejected too
 * - a usage-interval plan rejects a log without a usage reading (400, never guesses)
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

import maintenanceRoutes from '../routes/maintenance.js';

const USER = { id: 7, username: 'alice' };
const OTHER_USER = { id: 99, username: 'bob' };

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];

type Responder = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number | null } | undefined;

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

function planRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    user_id: USER.id,
    profile_id: null,
    asset_name: '大众迈腾',
    asset_kind: 'vehicle',
    interval_days: 180,
    interval_usage: 10000,
    usage_unit: 'km',
    current_usage: '52000',
    last_done_at: '2026-01-01',
    next_due_at: '2026-06-30',
    next_due_usage: '62000',
    notes: null,
    reminder_config: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function logRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    plan_id: 1,
    done_at: '2026-06-01',
    usage_at: '62000',
    cost_cents: null,
    notes: null,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await maintenanceRoutes.request(path, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

beforeEach(() => {
  authState.user = { ...USER };
  installDb();
});

describe('auth guard and CRUD basics', () => {
  it('returns 401 for every maintenance verb without a token', async () => {
    authState.user = null;
    const cases: Array<[string, string]> = [
      ['GET', '/'],
      ['GET', '/1'],
      ['GET', '/1/logs'],
      ['POST', '/'],
      ['PATCH', '/1'],
      ['DELETE', '/1'],
      ['POST', '/1/log'],
    ];
    for (const [method, path] of cases) {
      const { status, body } = await request(method, path);
      expect(status, `${method} ${path}`).toBe(401);
      expect(body.error).toBe('Unauthorized');
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('lists plans in the pagination shape, scoped by user, with filters', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('COUNT(*)::int AS count FROM maintenance_plans')) return { rows: [{ count: 1 }], rowCount: 1 };
      if (s.startsWith('SELECT * FROM maintenance_plans')) return { rows: [planRow()], rowCount: 1 };
      return undefined;
    });

    const { status, body } = await request('GET', '/?assetKind=vehicle&active=true&q=%E8%BF%88%E8%85%BE&limit=10');
    expect(status).toBe(200);
    expect(body.pagination).toEqual({ page: 1, limit: 10, total: 1, totalPages: 1 });

    const list = queriesMatching(/SELECT \* FROM maintenance_plans/).at(-1);
    expect(list?.sql).toContain('asset_kind = $2');
    expect(list?.sql).toContain('is_active = $3');
    expect(list?.sql).toContain('ILIKE $4');
    expect(list?.params[0]).toBe(USER.id);

    expect((await request('GET', '/?assetKind=nonsense')).status).toBe(400);
    expect((await request('GET', '/?active=maybe')).status).toBe(400);
  });

  it('rejects a plan with NEITHER interval with a clear validation error', async () => {
    const { status, body } = await request('POST', '/', { assetName: '空调' });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('至少设置一个保养间隔');
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('accepts a date-only plan and a usage-only plan (201)', async () => {
    installDb((sql) => (/^INSERT INTO maintenance_plans/.test(sql.replace(/\s+/g, ' ').trim()) ? { rows: [planRow()], rowCount: 1 } : undefined));

    const dateOnly = await request('POST', '/', { assetName: '净水器', intervalDays: 90 });
    expect(dateOnly.status).toBe(201);
    const usageOnly = await request('POST', '/', { assetName: '发电机', intervalUsage: 250, usageUnit: 'hours' });
    expect(usageOnly.status).toBe(201);

    const inserts = queriesMatching(/INSERT INTO maintenance_plans/);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params[0]).toBe(USER.id);
    expect(inserts[1].params).toContain(250);
  });

  it('rejects a malformed create (negative interval / text interval / bad unit) with 400', async () => {
    for (const payload of [
      { assetName: 'A', intervalDays: -1 },
      { assetName: 'A', intervalDays: '180' },
      { assetName: 'A', intervalUsage: 1.5 },
      { assetName: 'A', intervalDays: 30, usageUnit: 'lightyears' },
      { intervalDays: 30 },
    ]) {
      const { status } = await request('POST', '/', payload);
      expect(status, JSON.stringify(payload)).toBe(400);
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('PATCH is user-scoped; a patch that nulls BOTH intervals is rejected without writing', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('WHERE id = $1 AND user_id = $2')) return { rows: [planRow()], rowCount: 1 };
      if (s.startsWith('UPDATE maintenance_plans')) return { rows: [planRow({ notes: 'x' })], rowCount: 1 };
      return undefined;
    });

    const notesOnly = await request('PATCH', '/1', { notes: '换机油' });
    expect(notesOnly.status).toBe(200);

    installDb((sql) => (sql.includes('WHERE id = $1 AND user_id = $2') ? { rows: [planRow()], rowCount: 1 } : undefined));
    const bothNull = await request('PATCH', '/1', { intervalDays: null, intervalUsage: null });
    expect(bothNull.status).toBe(400);
    expect(String(bothNull.body.error)).toContain('至少设置一个保养间隔');
    // No UPDATE was issued - the plan keeps its interval.
    expect(queriesMatching(/UPDATE maintenance_plans/)).toHaveLength(0);

    // Nulling only one of two intervals is fine.
    const oneNull = await request('PATCH', '/1', { intervalUsage: null });
    expect(oneNull.status).toBe(200);
    const update = queriesMatching(/UPDATE maintenance_plans/).at(-1);
    expect(update?.sql).toContain('WHERE id = $1 AND user_id = $2');
    expect(update?.params.slice(0, 2)).toEqual([1, USER.id]);
  });

  it('returns 404 (not 403) for another user\'s plan', async () => {
    authState.user = { ...OTHER_USER };
    installDb(() => ({ rows: [], rowCount: 0 }));

    expect((await request('GET', '/1')).status).toBe(404);
    expect((await request('PATCH', '/1', { notes: 'x' })).status).toBe(404);
    expect((await request('DELETE', '/1')).status).toBe(404);
    expect((await request('POST', '/1/log', { doneAt: '2026-06-01', usageAt: 1 })).status).toBe(404);
  });

  it('serves the service history scoped through the plan owner', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('WHERE id = $1 AND user_id = $2')) return { rows: [planRow()], rowCount: 1 };
      if (s.includes('FROM maintenance_logs')) return { rows: [logRow()], rowCount: 1 };
      return undefined;
    });

    const { status, body } = await request('GET', '/1/logs');
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    const q = queriesMatching(/FROM maintenance_logs/).at(-1);
    expect(q?.sql).toContain('l.plan_id = $1');
    expect(q?.sql).toContain('p.user_id = $2');
    expect(q?.params).toEqual([1, USER.id]);

    installDb(() => ({ rows: [], rowCount: 0 }));
    expect((await request('GET', '/1/logs')).status).toBe(404);
  });
});

describe('POST /api/maintenance/:id/log — rescheduling maths', () => {
  it('180-day/10000km plan: next_due_at = done_at + 180d, next_due_usage = usage_at + 10000', async () => {
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.startsWith('SELECT * FROM maintenance_plans')) return { rows: [planRow()], rowCount: 1 };
      if (s.startsWith('UPDATE maintenance_plans')) {
        return {
          rows: [planRow({
            last_done_at: params[0],
            current_usage: String(params[1]),
            next_due_at: params[2],
            next_due_usage: String(params[3]),
          })],
          rowCount: 1,
        };
      }
      if (s.startsWith('INSERT INTO maintenance_logs')) return { rows: [logRow()], rowCount: 1 };
      return undefined;
    });

    const { status, body } = await request('POST', '/1/log', { doneAt: '2026-06-01', usageAt: 62000, costCents: 45000 });

    expect(status).toBe(201);
    const update = queriesMatching(/UPDATE maintenance_plans/).at(-1);
    expect(update).toBeDefined();
    expect(update!.sql).toContain('WHERE id = $5 AND user_id = $6');
    expect(update!.params).toEqual([ '2026-06-01', 62000, '2026-11-28', 72000, 1, USER.id ]);

    const inserted = queriesMatching(/INSERT INTO maintenance_logs/).at(-1);
    expect(inserted?.params).toEqual([1, '2026-06-01', 62000, 45000, null]);

    const data = body.data as Record<string, unknown>;
    expect(data.next_due_at).toBe('2026-11-28');
    expect(data.next_due_usage).toBe(72000);
  });

  it('a second log before the due date reschedules from the LATEST log', async () => {
    // The plan has already been moved to 2026-11-28 / 72000 by the first log.
    const afterFirst = planRow({
      last_done_at: '2026-06-01',
      current_usage: '62000',
      next_due_at: '2026-11-28',
      next_due_usage: '72000',
    });
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.startsWith('SELECT * FROM maintenance_plans')) return { rows: [afterFirst], rowCount: 1 };
      if (s.startsWith('UPDATE maintenance_plans')) {
        return {
          rows: [planRow({
            last_done_at: params[0],
            current_usage: String(params[1]),
            next_due_at: params[2],
            next_due_usage: String(params[3]),
          })],
          rowCount: 1,
        };
      }
      if (s.startsWith('INSERT INTO maintenance_logs')) return { rows: [logRow({ done_at: '2026-06-10', usage_at: '70000' })], rowCount: 1 };
      return undefined;
    });

    const { status, body } = await request('POST', '/1/log', { doneAt: '2026-06-10', usageAt: 70000 });
    expect(status).toBe(201);

    const update = queriesMatching(/UPDATE maintenance_plans/).at(-1);
    // Rescheduled from 2026-06-10 (the latest log), not from the previous 2026-06-01.
    expect(update!.params).toEqual([ '2026-06-10', 70000, '2026-12-07', 80000, 1, USER.id ]);
    expect((body.data as Record<string, unknown>).next_due_at).toBe('2026-12-07');
  });

  it('never moves the plan backwards when an older log is backfilled', async () => {
    const afterFirst = planRow({ last_done_at: '2026-06-01', current_usage: '62000', next_due_at: '2026-11-28', next_due_usage: '72000' });
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.startsWith('SELECT * FROM maintenance_plans')) return { rows: [afterFirst], rowCount: 1 };
      if (s.startsWith('UPDATE maintenance_plans')) {
        return { rows: [planRow({ last_done_at: params[0], next_due_at: params[2], next_due_usage: String(params[3]) })], rowCount: 1 };
      }
      if (s.startsWith('INSERT INTO maintenance_logs')) return { rows: [logRow({ done_at: '2026-05-01' })], rowCount: 1 };
      return undefined;
    });

    const { status } = await request('POST', '/1/log', { doneAt: '2026-05-01', usageAt: 40000 });
    expect(status).toBe(201);
    const update = queriesMatching(/UPDATE maintenance_plans/).at(-1);
    // Effective done_at stays 2026-06-01 (the latest), so next_due_at stays 2026-11-28.
    expect(update!.params[0]).toBe('2026-06-01');
    expect(update!.params[2]).toBe('2026-11-28');
  });

  it('rejects a usage-interval plan logged without a usage reading (400, no writes)', async () => {
    installDb((sql) => (sql.replace(/\s+/g, ' ').startsWith('SELECT * FROM maintenance_plans') ? { rows: [planRow()], rowCount: 1 } : undefined));

    const { status, body } = await request('POST', '/1/log', { doneAt: '2026-06-01' });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('usageAt');
    expect(queriesMatching(/UPDATE maintenance_plans/)).toHaveLength(0);
    expect(queriesMatching(/INSERT INTO maintenance_logs/)).toHaveLength(0);
  });

  it('a date-only plan keeps next_due_usage null even when a usage reading is supplied', async () => {
    const dateOnly = planRow({ interval_usage: null, usage_unit: null, next_due_usage: null, current_usage: null });
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.startsWith('SELECT * FROM maintenance_plans')) return { rows: [dateOnly], rowCount: 1 };
      if (s.startsWith('UPDATE maintenance_plans')) {
        return { rows: [planRow({ ...dateOnly, last_done_at: params[0], next_due_at: params[2] })], rowCount: 1 };
      }
      if (s.startsWith('INSERT INTO maintenance_logs')) return { rows: [logRow()], rowCount: 1 };
      return undefined;
    });

    const { status } = await request('POST', '/1/log', { doneAt: '2026-06-01', usageAt: 999 });
    expect(status).toBe(201);
    const update = queriesMatching(/UPDATE maintenance_plans/).at(-1);
    expect(update!.params[3]).toBeNull(); // next_due_usage
  });

  it('rejects malformed logs with 400 before touching the DB', async () => {
    for (const payload of [
      {},
      { doneAt: '2026/06/01' },
      { doneAt: '2026-06-01', usageAt: -1 },
      { doneAt: '2026-06-01', costCents: -1 },
      { doneAt: '2026-06-01', costCents: 1.5 },
    ]) {
      const { status } = await request('POST', '/1/log', payload);
      expect(status, JSON.stringify(payload)).toBe(400);
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('user scoping proof', () => {
  it('every SELECT/UPDATE/DELETE against maintenance tables carries a user_id predicate', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('COUNT(*)::int AS count FROM maintenance_plans')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (s.includes('WHERE id = $1 AND user_id = $2')) return { rows: [planRow()], rowCount: 1 };
      if (s.startsWith('SELECT * FROM maintenance_plans')) return { rows: [], rowCount: 0 };
      if (s.startsWith('INSERT INTO maintenance_plans')) return { rows: [planRow()], rowCount: 1 };
      if (s.startsWith('UPDATE maintenance_plans')) return { rows: [planRow()], rowCount: 1 };
      if (s.startsWith('DELETE FROM maintenance_plans')) return { rows: [], rowCount: 1 };
      if (s.includes('FROM maintenance_logs')) return { rows: [], rowCount: 0 };
      if (s.startsWith('INSERT INTO maintenance_logs')) return { rows: [logRow()], rowCount: 1 };
      return undefined;
    });

    await request('GET', '/');
    await request('GET', '/1');
    await request('GET', '/1/logs');
    await request('POST', '/', { assetName: 'A', intervalDays: 30 });
    await request('PATCH', '/1', { notes: 'x' });
    await request('DELETE', '/1');
    await request('POST', '/1/log', { doneAt: '2026-06-01', usageAt: 100 });

    const scopedStatements = captured.filter((q) => {
      const s = q.sql.replace(/\s+/g, ' ').trim();
      return /^(SELECT|UPDATE|DELETE)/.test(s) && s.includes('maintenance_');
    });
    expect(scopedStatements.length).toBeGreaterThanOrEqual(8);
    for (const q of scopedStatements) {
      expect(q.sql, `unscoped statement: ${q.sql}`).toContain('user_id = $');
      expect(q.params).toContain(USER.id);
    }
  });
});
