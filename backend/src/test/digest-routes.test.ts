import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 79 — route contract.
 *
 * - `GET /api/cron/digest` is CRON_SECRET-guarded (401 without `Bearer`), rejects an
 *   invalid period (400), and is NOT skipped by a stale `cron_execution_logs` row.
 * - `POST /api/digest/send` is auth-guarded and forwards the period for the session user.
 */

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendDigestsForAllUsers: vi.fn(),
  sendDigestForUser: vi.fn(),
  authState: { user: { id: 7, username: 'admin' } as { id: number; username: string } | null },
}));

vi.mock('../db/index.js', () => ({ query: mocks.dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));
vi.mock('../services/digest.service.js', () => ({
  sendDigestsForAllUsers: mocks.sendDigestsForAllUsers,
  sendDigestForUser: mocks.sendDigestForUser,
}));
vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  return {
    authMiddleware: async (c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response }, next: () => Promise<void>) => {
      if (mocks.authState.user) {
        c.set('user', mocks.authState.user);
        return next();
      }
      return actual.authMiddleware(c as never, next as never);
    },
  };
});

import cronRoutes from '../routes/cron.js';
import digestRoutes from '../routes/digest.js';

const CRON_SECRET = 'digest-test-cron-secret';

beforeEach(() => {
  process.env.CRONSECRET = CRON_SECRET;
  delete process.env.CRON_SECRET;
  delete process.env.CRON_ALLOWED_IPS;
  mocks.dbQuery.mockReset();
  mocks.dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.sendDigestsForAllUsers.mockReset();
  mocks.sendDigestsForAllUsers.mockResolvedValue({ period: 'monthly', users: 3, sent: 3, skipped: 0, results: [] });
  mocks.sendDigestForUser.mockReset();
  mocks.sendDigestForUser.mockResolvedValue({ userId: 7, period: 'monthly', from: '2026-09-01', to: '2026-09-30', emailed: true, recipients: ['me@example.com'], inbox: true });
  mocks.authState.user = { id: 7, username: 'admin' };
});

describe('GET /api/cron/digest', () => {
  it('returns 401 without a Bearer CRON_SECRET and never runs the job', async () => {
    const res = await cronRoutes.request('/digest?period=monthly');
    expect(res.status).toBe(401);
    expect(mocks.sendDigestsForAllUsers).not.toHaveBeenCalled();
  });

  it('rejects an invalid period with 400 (authenticated)', async () => {
    // v2.30: daily/weekly are now valid periods — 'hourly' is the invalid example
    const res = await cronRoutes.request('/digest?period=hourly', { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(res.status).toBe(400);
    expect(mocks.sendDigestsForAllUsers).not.toHaveBeenCalled();
  });

  it('runs the monthly digest exactly once when authenticated', async () => {
    const res = await cronRoutes.request('/digest?period=monthly', { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; sent: number };
    expect(body.success).toBe(true);
    expect(body.sent).toBe(3);
    expect(mocks.sendDigestsForAllUsers).toHaveBeenCalledTimes(1);
    expect(mocks.sendDigestsForAllUsers).toHaveBeenCalledWith('monthly');
  });

  it('defaults to monthly when the period query is omitted', async () => {
    const res = await cronRoutes.request('/digest', { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(res.status).toBe(200);
    expect(mocks.sendDigestsForAllUsers).toHaveBeenCalledWith('monthly');
  });

  it('stale-state: a pre-existing digest-monthly cron row does not skip the run', async () => {
    mocks.dbQuery.mockResolvedValue({ rows: [{ job_name: 'digest-monthly', status: 'success', executed_at: '2026-09-01T01:00:00Z' }], rowCount: 1 });

    const res = await cronRoutes.request('/digest?period=monthly', { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(res.status).toBe(200);
    // The job never consults cron_execution_logs for a dedup decision.
    expect(mocks.sendDigestsForAllUsers).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/digest/send', () => {
  it('forwards the requested period for the session user and returns the result', async () => {
    const res = await digestRoutes.request('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period: 'yearly' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; emailed: boolean };
    expect(body.success).toBe(true);
    expect(mocks.sendDigestForUser).toHaveBeenCalledWith(7, 'yearly');
  });

  it('defaults to monthly and rejects an invalid period with 400', async () => {
    const ok = await digestRoutes.request('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(ok.status).toBe(200);
    expect(mocks.sendDigestForUser).toHaveBeenCalledWith(7, 'monthly');

    const bad = await digestRoutes.request('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period: 'hourly' }) });
    expect(bad.status).toBe(400);
  });

  it('surfaces a delivery failure as 500', async () => {
    mocks.sendDigestForUser.mockRejectedValue(new Error('smtp down'));
    const res = await digestRoutes.request('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period: 'monthly' }) });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('smtp down');
  });
});
