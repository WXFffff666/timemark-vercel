/**
 * Route-level tests for POST /api/trigger-logs/retry-failed (v79 批量重试).
 *
 * Contract pinned here:
 *  - only rows whose derived delivery outcome is NOT 'delivered' are candidates
 *    (partial failures stored with status='success' are still retryable);
 *  - the per-call cap (default 10, clamp 1..50) bounds how many rows actually resend;
 *  - rows whose event is gone / no channels resolve surface as failed entries,
 *    never as a batch-level 500;
 *  - requires auth.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendNotifications: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: mocks.query,
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
  sendNotifications: mocks.sendNotifications,
}));

vi.mock('../services/config.service.js', () => ({
  getUserConfig: vi.fn(async () => null),
  getRelationshipMappings: vi.fn(async () => []),
  getNotificationAccounts: vi.fn(async () => []),
  getEventTemplate: vi.fn(async () => null),
}));

import triggerLogsRoutes from '../routes/trigger-logs.js';

const USER = { id: 7, username: 'alice' };

function failedRow(id: number): Record<string, unknown> {
  return {
    id,
    status: 'failed',
    channel_results: JSON.stringify({ discord: { success: false, error: 'boom' } }),
    error_message: 'boom',
    channel_type: 'discord',
    account_id: null,
    retry_count: 0,
    event_id: null,
    notification_channels: null,
    reminder_config: null,
  };
}

/**
 * 按 SQL 分发的 query mock：
 *  - LIMIT 200        → 最近日志列表（测试用 rows 指定）
 *  - FROM event_trigger_logs tl → 按 id 取单行（重试 SELECT tl.*）
 *  - UPDATE ...       → rowCount 1
 */
function installQueryMock(recentRows: Array<Record<string, unknown>>): void {
  mocks.query.mockImplementation((sql: string, params: unknown[]) => {
    if (sql.includes('LIMIT 200')) {
      return Promise.resolve({ rows: recentRows, rowCount: recentRows.length });
    }
    if (sql.includes('FROM event_trigger_logs tl')) {
      const id = Number(params[0]);
      const row = recentRows.find((r) => Number(r.id) === id);
      return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetAllMocks();
  authState.user = USER;
  mocks.sendNotifications.mockResolvedValue({ discord: { success: true } });
});

describe('POST /trigger-logs/retry-failed (v79)', () => {
  it('retries only non-delivered rows and reports the summary', async () => {
    installQueryMock([
      { id: 1, status: 'failed', channel_results: JSON.stringify({ discord: { success: false } }), error_message: 'x', channel_type: null, notification_channels: null },
      { id: 2, status: 'success', channel_results: JSON.stringify({ discord: { success: true } }), error_message: null, channel_type: null }, // delivered → skipped
      { id: 3, status: 'success', channel_results: JSON.stringify({ discord: { success: true }, slack: { success: false } }), error_message: null, channel_type: null }, // partial → retryable
      { id: 4, status: 'skipped', channel_results: JSON.stringify({ _quiet_hours: { success: false } }), error_message: null, channel_type: null }, // internal marker only → no channels → not_retryable
    ]);

    const res = await triggerLogsRoutes.request('/retry-failed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { attempted: number; retried: number; failed: number; candidates: number; results: Array<{ id: number; ok: boolean }> };
    };
    expect(body.data.candidates).toBe(3); // rows 1 and 3 retryable; row 4 non-delivered but has no real channels
    expect(body.data.attempted).toBe(3);
    expect(body.data.results.map((r) => r.id)).toEqual([1, 3, 4]);
    expect(body.data.results.find((r) => r.id === 4)?.ok).toBe(false); // no channels → not_retryable
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(2);
  });

  it('clamps the requested limit and stops at the cap', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => failedRow(i + 1));
    installQueryMock(rows);

    const res = await triggerLogsRoutes.request('/retry-failed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 3 }),
    });
    const body = await res.json() as { data: { attempted: number; candidates: number } };
    expect(body.data.attempted).toBe(3);
    expect(body.data.candidates).toBe(20);
    expect(mocks.sendNotifications).toHaveBeenCalledTimes(3);  });

  it('requires auth', async () => {
    authState.user = null;
    const res = await triggerLogsRoutes.request('/retry-failed', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
