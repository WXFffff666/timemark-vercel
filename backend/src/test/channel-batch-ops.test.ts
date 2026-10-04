/**
 * Route-level tests for the v78 channel batch endpoints:
 *   - GET  /channels/stats    (30-day per-channel success aggregation from event_trigger_logs)
 *   - POST /channels/test-all (batch self-test: concurrent, persists results, clears suspension)
 *   - POST /channels/resume   (manual recovery of a 24h-suspended account)
 *
 * Contract pinned here:
 *  - stats: `_`-prefixed internal keys and malformed JSON rows are ignored, never counted;
 *  - test-all: per-account failures are isolated (one broken account never fails the batch),
 *    results are persisted, and a success clears suspended_until;
 *  - resume: only the owner's account can be resumed (user_id scoped), 404 otherwise.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  testConnection: vi.fn(),
  getNotificationAccounts: vi.fn(),
  classifyChannelTestResult: vi.fn(),
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

vi.mock('../services/notifications/test-connection.js', () => ({
  testConnection: mocks.testConnection,
}));

vi.mock('../services/config.service.js', () => ({
  getNotificationAccounts: mocks.getNotificationAccounts,
}));

vi.mock('./cron.js', () => ({
  classifyChannelTestResult: mocks.classifyChannelTestResult,
}));

vi.mock('../utils/notification-recipients.js', () => ({
  resolveEmailRecipientForTest: vi.fn(async () => undefined),
}));

import channelsRoutes from '../routes/channels.js';

const USER = { id: 7, username: 'alice' };

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = USER;
  mocks.classifyChannelTestResult.mockReturnValue({ connectionStatus: 'healthy', lastTestResult: 'success' });
});

describe('GET /channels/stats (v78)', () => {
  it('aggregates per-channel success/failure and ignores _-prefixed internal keys', async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          channel_results: JSON.stringify({
            discord: { success: true },
            resend: { success: false, error: 'boom' },
            _fallback_discord: { success: true },
          }),
        },
        { channel_results: 'not-json{' },
        { channel_results: JSON.stringify({ discord: { success: true }, telegram: { success: true } }) },
      ],
    });

    const res = await channelsRoutes.request('/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { runs: number; channels: Array<{ channel: string; sent: number; ok: number; failed: number; successRate: number }> } };
    expect(body.success).toBe(true);
    expect(body.data.runs).toBe(2); // the malformed row is skipped
    const byChannel = new Map(body.data.channels.map((c) => [c.channel, c]));
    expect(byChannel.get('discord')).toMatchObject({ sent: 2, ok: 2, failed: 0, successRate: 100 });
    expect(byChannel.get('resend')).toMatchObject({ sent: 1, ok: 0, failed: 1 });
    expect(byChannel.get('telegram')).toMatchObject({ sent: 1, ok: 1 });
    expect(byChannel.has('_fallback_discord')).toBe(false);
  });

  it('returns an empty channel list when nothing was logged', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const res = await channelsRoutes.request('/stats');
    const body = await res.json() as { data: { channels: unknown[]; runs: number } };
    expect(body.data.channels).toEqual([]);
    expect(body.data.runs).toBe(0);
  });
});

describe('POST /channels/test-all (v78)', () => {
  it('tests every active account, persists results and clears suspension on success', async () => {
    mocks.getNotificationAccounts.mockResolvedValue([
      { id: 1, type: 'discord', name: 'D1', config_method: 'webhook', webhook: 'https://d', is_active: true },
      { id: 2, type: 'telegram', name: 'T1', config_method: 'token', token: 't', chat_id: 'c', is_active: true },
    ]);
    mocks.testConnection.mockImplementation(async (cfg: { type: string }) =>
      cfg.type === 'discord'
        ? { success: true, message: 'ok' }
        : { success: false, message: 'bad token' });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await channelsRoutes.request('/test-all', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { summary: { total: number; passed: number; failed: number }; results: Array<{ accountId: number; success: boolean }> };
    };
    expect(body.data.summary).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(body.data.results.find((r) => r.accountId === 1)?.success).toBe(true);
    expect(body.data.results.find((r) => r.accountId === 2)?.success).toBe(false);

    // both accounts got their test outcome persisted; account 1 (success) also cleared suspended_until
    const updates = mocks.query.mock.calls.map(([, params]) => params) as unknown[][];
    expect(updates.length).toBe(2);
    expect(updates[0]).toEqual(['success', 'healthy', 1]);
    expect(mocks.query.mock.calls[0][0]).toContain('suspended_until = NULL');
  });

  it('keeps the batch alive when a single test call throws', async () => {
    mocks.getNotificationAccounts.mockResolvedValue([
      { id: 1, type: 'discord', name: 'D1', config_method: 'webhook', webhook: 'https://d', is_active: true },
      { id: 2, type: 'kook', name: 'K1', config_method: 'webhook', webhook: 'https://k', is_active: true },
    ]);
    mocks.testConnection.mockImplementation(async (cfg: { type: string }) => {
      if (cfg.type === 'discord') throw new Error('network split');
      return { success: true, message: 'ok' };
    });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await channelsRoutes.request('/test-all', { method: 'POST' });
    const body = await res.json() as { data: { summary: { total: number; passed: number; failed: number } } };
    expect(body.data.summary).toEqual({ total: 2, passed: 1, failed: 1 });
  });

  it('returns a zero summary when the user has no active accounts', async () => {
    mocks.getNotificationAccounts.mockResolvedValue([]);
    const res = await channelsRoutes.request('/test-all', { method: 'POST' });
    const body = await res.json() as { data: { summary: { total: number } } };
    expect(body.data.summary.total).toBe(0);
    expect(mocks.testConnection).not.toHaveBeenCalled();
  });
});

describe('POST /channels/resume (v78)', () => {
  it('clears suspended_until for an owned account', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await channelsRoutes.request('/resume', {
      method: 'POST',
      body: JSON.stringify({ accountId: 3 }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('suspended_until = NULL');
    expect(params).toEqual([3, USER.id]);
  });

  it('is scoped to the owner: another user\'s account is 404', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await channelsRoutes.request('/resume', {
      method: 'POST',
      body: JSON.stringify({ accountId: 3 }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('rejects a missing/invalid accountId', async () => {
    const res = await channelsRoutes.request('/resume', {
      method: 'POST',
      body: JSON.stringify({ accountId: 'abc' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });
});
