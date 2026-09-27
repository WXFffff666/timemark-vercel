import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 49 acceptance: /api/inventory CRUD + expiring + low-stock + consume.
 *
 * - every verb is auth-guarded (401 without a token)
 * - every query is user-scoped; another user's row is a 404 (not 403)
 * - POST /:id/consume is a single guarded UPDATE (`quantity >= $3`): consuming more
 *   than the row holds is REJECTED with 400 - never silently clamped to 0
 * - GET /expiring returns only rows with a non-null expires_at inside the window
 * - GET /low-stock returns exactly the rows at or below their own threshold
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

import inventoryRoutes from '../routes/inventory.js';

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

function itemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    user_id: USER.id,
    profile_id: null,
    name: '牛奶',
    category: 'food',
    quantity: '2',
    unit: '盒',
    low_stock_threshold: '3',
    purchased_at: '2026-05-01',
    expires_at: '2026-06-05',
    location: '冰箱',
    notes: null,
    reminder_config: null,
    is_active: true,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await inventoryRoutes.request(path, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

beforeEach(() => {
  authState.user = { ...USER };
  installDb();
});

describe('GET /api/inventory — auth guard, scoping and pagination', () => {
  it('returns 401 for every inventory verb without a token', async () => {
    authState.user = null;
    const cases: Array<[string, string]> = [
      ['GET', '/'],
      ['GET', '/expiring'],
      ['GET', '/low-stock'],
      ['GET', '/1'],
      ['POST', '/'],
      ['PATCH', '/1'],
      ['DELETE', '/1'],
      ['POST', '/1/consume'],
    ];
    for (const [method, path] of cases) {
      const { status, body } = await request(method, path);
      expect(status, `${method} ${path}`).toBe(401);
      expect(body.error).toBe('Unauthorized');
    }
    // Nothing reached the DB before auth.
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('returns { data, pagination } and scopes by user', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('COUNT(*)::int AS count FROM inventory_items')) return { rows: [{ count: 2 }], rowCount: 1 };
      if (s.startsWith('SELECT * FROM inventory_items')) return { rows: [itemRow()], rowCount: 1 };
      return undefined;
    });

    const { status, body } = await request('GET', '/?page=2&limit=1');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });

    const listQueries = queriesMatching(/FROM inventory_items/);
    expect(listQueries.length).toBe(2);
    for (const q of listQueries) {
      expect(q.sql).toContain('user_id = $1');
      expect(q.params[0]).toBe(USER.id);
    }
    const list = listQueries.find((q) => q.sql.includes('SELECT *'));
    expect(list?.params.slice(-2)).toEqual([1, 1]);
  });

  it('passes category/active/lowStock/q through as scoped predicates', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('COUNT(*)::int AS count FROM inventory_items')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (s.startsWith('SELECT * FROM inventory_items')) return { rows: [], rowCount: 0 };
      return undefined;
    });

    const { status } = await request('GET', '/?category=food&active=true&lowStock=true&q=milk');
    expect(status).toBe(200);

    const list = queriesMatching(/SELECT \* FROM inventory_items/).at(-1);
    expect(list).toBeDefined();
    const sql = list!.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('category = $2');
    expect(sql).toContain('is_active = $3');
    expect(sql).toContain('low_stock_threshold IS NOT NULL AND quantity <= low_stock_threshold');
    expect(sql).toContain('ILIKE $4');
    expect(list!.params).toEqual([USER.id, 'food', true, '%milk%', 50, 0]);
  });

  it('rejects malformed filters with 400', async () => {
    expect((await request('GET', '/?category=nonsense')).status).toBe(400);
    expect((await request('GET', '/?active=maybe')).status).toBe(400);
    expect((await request('GET', '/?lowStock=maybe')).status).toBe(400);
  });
});

describe('GET /api/inventory/expiring — null expires_at never appears', () => {
  it('returns only non-null expires_at rows inside the window, ordered by expiry', async () => {
    installDb((sql) => {
      if (sql.includes('expires_at IS NOT NULL')) {
        // The mocked DB is deliberately over-broad: it also returns a non-perishable
        // (expires_at null). The service must drop it before responding.
        return {
          rows: [
            itemRow({ id: 1, expires_at: '2026-06-05' }),
            itemRow({ id: 2, name: '洗衣液', expires_at: null }),
          ],
          rowCount: 2,
        };
      }
      return undefined;
    });

    const { status, body } = await request('GET', '/expiring?days=7');
    expect(status).toBe(200);
    expect(body.days).toBe(7);
    expect(body.data).toHaveLength(1);
    expect((body.data as Array<Record<string, unknown>>)[0].expires_at).toBe('2026-06-05');

    const q = queriesMatching(/expires_at IS NOT NULL/).at(-1);
    expect(q?.sql).toContain('user_id = $1');
    expect(q?.sql).toContain('expires_at <= CURRENT_DATE + ($2::int * INTERVAL');
    expect(q?.sql).toContain('ORDER BY expires_at ASC');
    expect(q?.params).toEqual([USER.id, 7]);

    const clamped = await request('GET', '/expiring?days=99999');
    expect(clamped.body.days).toBe(3650);
  });
});

describe('GET /api/inventory/low-stock — exactly at or below threshold', () => {
  it('keeps only rows whose quantity <= their own threshold (equal counts, null excluded)', async () => {
    installDb((sql) => {
      if (sql.includes('low_stock_threshold IS NOT NULL')) {
        return {
          rows: [
            itemRow({ id: 1, quantity: '2', low_stock_threshold: '3' }), // low
            itemRow({ id: 2, quantity: '3', low_stock_threshold: '3' }), // at threshold -> low
            itemRow({ id: 3, quantity: '5', low_stock_threshold: '3' }), // above -> excluded
            itemRow({ id: 4, quantity: '0.5', low_stock_threshold: null }), // untracked -> excluded
          ],
          rowCount: 4,
        };
      }
      return undefined;
    });

    const { status, body } = await request('GET', '/low-stock');
    expect(status).toBe(200);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data.map((row) => row.id)).toEqual([1, 2]);

    const q = queriesMatching(/low_stock_threshold IS NOT NULL/).at(-1);
    expect(q?.sql).toContain('user_id = $1');
    expect(q?.sql).toContain('quantity <= low_stock_threshold');
    expect(q?.params).toEqual([USER.id]);
  });
});

describe('POST /api/inventory — validation and create', () => {
  it('creates an item scoped to the user (quantity defaults to 1) and returns 201', async () => {
    installDb((sql) => {
      if (/^INSERT INTO inventory_items/.test(sql.replace(/\s+/g, ' ').trim())) {
        return { rows: [itemRow({ id: 42 })], rowCount: 1 };
      }
      return undefined;
    });

    const { status, body } = await request('POST', '/', {
      name: '牛奶',
      category: 'food',
      unit: '盒',
      lowStockThreshold: 3,
      expiresAt: '2026-06-05',
      purchasedAt: '2026-05-01',
      reminderConfig: { daysBeforeList: [7, 1] },
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);

    const insert = queriesMatching(/INSERT INTO inventory_items/).at(-1);
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe(USER.id);
    expect(insert!.params).toContain('牛奶');
    expect(insert!.params).toContain(1); // default quantity
    expect(insert!.params).toContain('2026-06-05');
  });

  it('rejects malformed payloads with 400 before touching the DB', async () => {
    const base = { name: 'X' };
    const badPayloads: unknown[] = [
      { ...base, quantity: -1 },
      { ...base, lowStockThreshold: -3 },
      { ...base, category: 'nonsense' },
      { ...base, quantity: '2' },
      { ...base, purchasedAt: '2026-06-01', expiresAt: '2026-05-01' },
      {},
    ];
    for (const payload of badPayloads) {
      const { status, body } = await request('POST', '/', payload);
      expect(status, JSON.stringify(payload)).toBe(400);
      expect(body.success).toBe(false);
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('PATCH/DELETE /api/inventory/:id — user scoping', () => {
  it('updates only the owner\'s row', async () => {
    installDb((sql) => (sql.includes('UPDATE inventory_items') ? { rows: [itemRow({ name: '新名称' })], rowCount: 1 } : undefined));

    const { status } = await request('PATCH', '/1', { name: '新名称' });
    expect(status).toBe(200);

    const update = queriesMatching(/UPDATE inventory_items/).at(-1);
    expect(update?.sql).toContain('WHERE id = $1 AND user_id = $2');
    expect(update?.params.slice(0, 2)).toEqual([1, USER.id]);
  });

  it('returns 404 (not 403) for another user\'s item on PATCH and DELETE', async () => {
    authState.user = { ...OTHER_USER };
    installDb(() => ({ rows: [], rowCount: 0 }));

    const patch = await request('PATCH', '/1', { name: 'steal' });
    expect(patch.status).toBe(404);
    expect(patch.body.error).toBe('库存项不存在');

    const del = await request('DELETE', '/1');
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('库存项不存在');
  });

  it('fetches a single item scoped by user (404 for foreign rows)', async () => {
    installDb((sql) => (sql.includes('WHERE id = $1 AND user_id = $2') ? { rows: [itemRow()], rowCount: 1 } : undefined));
    const own = await request('GET', '/1');
    expect(own.status).toBe(200);
    const get = queriesMatching(/WHERE id = \$1 AND user_id = \$2/).at(-1);
    expect(get?.sql).toContain('user_id = $2');
    expect(get?.params).toEqual([1, USER.id]);

    installDb(() => ({ rows: [], rowCount: 0 }));
    expect((await request('GET', '/1')).status).toBe(404);
  });

  it('rejects a malformed patch and a malformed id with 400', async () => {
    expect((await request('PATCH', '/1', { quantity: -5 })).status).toBe(400);
    expect((await request('PATCH', '/abc', { name: 'x' })).status).toBe(400);
    expect((await request('GET', '/abc')).status).toBe(400);
  });
});

describe('POST /api/inventory/:id/consume — guarded decrement, never clamped', () => {
  it('decrements through a single guarded UPDATE scoped to the user', async () => {
    installDb((sql) => {
      if (sql.includes('quantity = quantity - $3')) return { rows: [itemRow({ quantity: '0.5' })], rowCount: 1 };
      return undefined;
    });

    const { status, body } = await request('POST', '/1/consume', { quantity: 1.5 });
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).quantity).toBe(0.5);

    const update = queriesMatching(/quantity = quantity - \$3/).at(-1);
    expect(update?.sql).toContain('WHERE id = $1 AND user_id = $2 AND quantity >= $3');
    expect(update?.params).toEqual([1, USER.id, 1.5]);
  });

  it('REJECTS a consume larger than the stored quantity with 400 (no clamp, no write)', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      // The guarded UPDATE matches no row...
      if (s.includes('quantity = quantity - $3')) return { rows: [], rowCount: 0 };
      // ...and the ownership re-read shows only 1 unit on hand.
      if (s.includes('WHERE id = $1 AND user_id = $2')) return { rows: [itemRow({ quantity: '1' })], rowCount: 1 };
      return undefined;
    });

    const { status, body } = await request('POST', '/1/consume', { quantity: 2 });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('库存不足');
    expect((body.data as Record<string, unknown>).quantity).toBe(1); // the row is unchanged

    // Exactly one UPDATE ran and it carried the guard; nothing clamped the value.
    const updates = queriesMatching(/UPDATE inventory_items/);
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('quantity >= $3');
    expect(updates[0].params).toEqual([1, USER.id, 2]);
  });

  it('rejects zero/negative/non-numeric consume amounts with 400 before touching the DB', async () => {
    for (const payload of [{ quantity: 0 }, { quantity: -1 }, { quantity: '1' }, {}]) {
      const { status } = await request('POST', '/1/consume', payload);
      expect(status, JSON.stringify(payload)).toBe(400);
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('returns 404 (not 403) when consuming another user\'s item', async () => {
    authState.user = { ...OTHER_USER };
    installDb(() => ({ rows: [], rowCount: 0 }));

    const { status, body } = await request('POST', '/1/consume', { quantity: 1 });
    expect(status).toBe(404);
    expect(body.error).toBe('库存项不存在');
  });
});

describe('user scoping proof', () => {
  it('every SELECT/UPDATE/DELETE against inventory_items carries a user_id predicate', async () => {
    installDb((sql) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('COUNT(*)::int AS count FROM inventory_items')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (s.includes('WHERE id = $1 AND user_id = $2')) return { rows: [itemRow()], rowCount: 1 };
      if (s.startsWith('SELECT * FROM inventory_items')) return { rows: [], rowCount: 0 };
      if (s.startsWith('INSERT INTO inventory_items')) return { rows: [itemRow()], rowCount: 1 };
      if (s.startsWith('UPDATE inventory_items')) return { rows: [itemRow()], rowCount: 1 };
      if (s.startsWith('DELETE FROM inventory_items')) return { rows: [], rowCount: 1 };
      return undefined;
    });

    await request('GET', '/');
    await request('GET', '/expiring');
    await request('GET', '/low-stock');
    await request('GET', '/1');
    await request('POST', '/', { name: 'X' });
    await request('PATCH', '/1', { name: 'Y' });
    await request('DELETE', '/1');
    await request('POST', '/1/consume', { quantity: 1 });

    const scopedStatements = captured.filter((q) => {
      const s = q.sql.replace(/\s+/g, ' ').trim();
      return /^(SELECT|UPDATE|DELETE)/.test(s) && s.includes('inventory_items');
    });
    expect(scopedStatements.length).toBeGreaterThanOrEqual(8);
    for (const q of scopedStatements) {
      expect(q.sql, `unscoped statement: ${q.sql}`).toContain('user_id = $');
      expect(q.params).toContain(USER.id);
    }
  });
});
