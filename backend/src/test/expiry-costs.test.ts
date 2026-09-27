import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 46 acceptance: cost aggregation.
 *
 * Fixture: monthly 1999 + quarterly 3000 + yearly 12000 (CNY, recurring) and
 * once 50000 (USD, one-off).
 *  - normalised monthly total: 1999 + 1000 + 1000 = 3999 CNY
 *  - once is excluded from the recurring totals and listed separately
 *  - mixed currencies are NEVER summed (totalCents becomes 0 + mixedCurrencies=true;
 *    the truth lives in byCurrency)
 *  - zero items -> { totalCents: 0, byKind: [] } (not null, no divide-by-zero)
 *  - GET /api/stats carries the same expiry block
 */

const authState = vi.hoisted(() => ({ user: { id: 7, username: 'alice' } }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', () => ({
  authMiddleware: async (c: { set: (key: 'user', value: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', authState.user);
    await next();
  },
}));

vi.mock('../jobs/tasks.js', () => ({
  sendReminders: vi.fn(),
}));

import expiryRoutes from '../routes/expiry.js';
import statsRoutes from '../routes/stats.js';

const USER_ID = 7;

interface CostRow {
  kind: string;
  amount_cents: string | null;
  currency: string;
  cycle: string;
  cycle_days: number | null;
  next_due_date: string;
}

const FIXTURE: CostRow[] = [
  { kind: 'subscription', amount_cents: '1999', currency: 'CNY', cycle: 'monthly', cycle_days: null, next_due_date: '2026-02-15' },
  { kind: 'bill', amount_cents: '3000', currency: 'CNY', cycle: 'quarterly', cycle_days: null, next_due_date: '2026-03-01' },
  { kind: 'insurance', amount_cents: '12000', currency: 'CNY', cycle: 'yearly', cycle_days: null, next_due_date: '2026-06-01' },
  { kind: 'domain', amount_cents: '50000', currency: 'USD', cycle: 'once', cycle_days: null, next_due_date: '2026-04-01' },
];

let captured: Array<{ sql: string; params: unknown[] }>;

function installDb(rows: CostRow[] = FIXTURE): void {
  captured = [];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM expiry_items') && s.includes('is_active = TRUE')) {
      return { rows, rowCount: rows.length };
    }
    if (s.includes('FROM expiry_items WHERE user_id')) {
      // getExpirySummary
      return {
        rows: [{
          total: rows.length,
          active: rows.length,
          overdue: rows.filter((r) => r.next_due_date < '2026-01-01').length,
          due_soon: 0,
        }],
        rowCount: 1,
      };
    }
    if (s.includes('FROM events')) return { rows: [{ count: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

async function getCosts(query = ''): Promise<Record<string, unknown>> {
  const res = await expiryRoutes.request(`/costs${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
  expect(body.success).toBe(true);
  return body.data;
}

beforeEach(() => {
  installDb();
});

describe('GET /api/expiry/costs — normalisation fixture', () => {
  it('normalises monthly/quarterly/yearly and keeps once separate, grouped by currency', async () => {
    const data = await getCosts();

    expect(data.totalCents).toBe(3999);
    expect(data.currency).toBe('CNY');
    expect(data.mixedCurrencies).toBe(false);
    expect(data.byCurrency).toEqual({ CNY: 3999 });
    expect(data.byKind).toEqual([
      { kind: 'bill', currency: 'CNY', cents: 1000, count: 1 },
      { kind: 'insurance', currency: 'CNY', cents: 1000, count: 1 },
      { kind: 'subscription', currency: 'CNY', cents: 1999, count: 1 },
    ]);
    expect(data.monthly).toEqual([
      { month: '2026-02', currency: 'CNY', cents: 1999 },
      { month: '2026-03', currency: 'CNY', cents: 1000 },
      { month: '2026-06', currency: 'CNY', cents: 1000 },
    ]);
    expect(data.once).toEqual({
      totalCents: 50000,
      currency: 'USD',
      byCurrency: { USD: 50000 },
      count: 1,
    });

    // The aggregation only considers active rows and is user-scoped.
    const q = captured.find((c) => c.sql.includes('FROM expiry_items') && c.sql.includes('is_active = TRUE'));
    expect(q?.sql).toContain('user_id = $1');
    expect(q?.params[0]).toBe(USER_ID);
  });

  it('never sums across currencies when a second currency is present', async () => {
    installDb([
      ...FIXTURE,
      { kind: 'subscription', amount_cents: '1200', currency: 'USD', cycle: 'monthly', cycle_days: null, next_due_date: '2026-02-20' },
    ]);

    const data = await getCosts();

    // If the implementation summed currencies this would be 5199.
    expect(data.totalCents).toBe(0);
    expect(data.totalCents).not.toBe(5199);
    expect(data.mixedCurrencies).toBe(true);
    expect(data.currency).toBeNull();
    expect(data.byCurrency).toEqual({ CNY: 3999, USD: 1200 });

    // byKind keeps the currency dimension - CNY and USD entries are distinct.
    const usd = (data.byKind as Array<{ kind: string; currency: string; cents: number }>).filter((k) => k.currency === 'USD');
    const cny = (data.byKind as Array<{ kind: string; currency: string; cents: number }>).filter((k) => k.currency === 'CNY');
    expect(usd).toEqual([{ kind: 'subscription', currency: 'USD', cents: 1200, count: 1 }]);
    expect(cny.reduce((sum, k) => sum + k.cents, 0)).toBe(3999);

    // monthly buckets are also per-currency.
    expect(data.monthly).toEqual([
      { month: '2026-02', currency: 'CNY', cents: 1999 },
      { month: '2026-02', currency: 'USD', cents: 1200 },
      { month: '2026-03', currency: 'CNY', cents: 1000 },
      { month: '2026-06', currency: 'CNY', cents: 1000 },
    ]);
  });

  it('returns { totalCents: 0, byKind: [] } for zero items (no NaN / divide-by-zero)', async () => {
    installDb([]);

    const data = await getCosts();

    expect(data.totalCents).toBe(0);
    expect(data.byKind).toEqual([]);
    expect(data.byCurrency).toEqual({});
    expect(data.monthly).toEqual([]);
    expect(data.mixedCurrencies).toBe(false);
    expect(data.currency).toBeNull();
    expect(JSON.stringify(data)).not.toContain('NaN');
  });

  it('supports yearly bucketing and passes from/to through as parameters', async () => {
    const data = await getCosts('?granularity=year&from=2026-01-01&to=2026-12-31');
    expect(data.monthly).toEqual([
      { month: '2026', currency: 'CNY', cents: 3999 },
    ]);
    const q = captured.find((c) => c.sql.includes('FROM expiry_items') && c.sql.includes('is_active = TRUE'));
    expect(q?.params).toEqual([USER_ID, '2026-01-01', '2026-12-31']);
  });

  it('rejects an unknown granularity with 400', async () => {
    const res = await expiryRoutes.request('/costs?granularity=week');
    expect(res.status).toBe(400);
  });

  it('treats custom cycle_days as a recurring monthly cost and excludes malformed custom', async () => {
    installDb([
      { kind: 'custom', amount_cents: '365', currency: 'CNY', cycle: 'custom', cycle_days: 365, next_due_date: '2026-02-01' },
      { kind: 'custom', amount_cents: '999', currency: 'CNY', cycle: 'custom', cycle_days: null, next_due_date: '2026-02-01' },
    ]);

    const data = await getCosts();
    // 365 CNY billed every 365 days ≈ 30 CNY/month; the malformed one is once-like.
    expect(data.totalCents).toBe(30);
    expect((data.once as { count: number }).count).toBe(1);
  });
});

describe('GET /api/stats — expiry block', () => {
  it('surfaces expiry counts and cost aggregation', async () => {
    installDb();

    const res = await statsRoutes.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);

    const expiry = body.data.expiry as Record<string, unknown>;
    expect(expiry.total).toBe(4);
    expect(expiry.active).toBe(4);
    expect(expiry.overdue).toBe(0);
    expect(expiry.dueSoon).toBe(0);

    const costs = expiry.costs as Record<string, unknown>;
    expect(costs.totalCents).toBe(3999);
    expect(costs.byCurrency).toEqual({ CNY: 3999 });

    // Existing stats fields stay intact (additive change only).
    expect(body.data).toHaveProperty('totalEvents');
    expect(body.data).toHaveProperty('eventsByType');
  });
});
