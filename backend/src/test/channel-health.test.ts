/**
 * Route-level tests for GET /channel-health (plan checkbox 11).
 *
 * Failing-first contract:
 *  - supported + working  -> connection_status='healthy',   last_test_result='success'
 *  - supported + broken   -> connection_status='unhealthy', last_test_result='failed'
 *  - supported type with no test path (testConnection replies 暂不支持测试)
 *    -> connection_status='unknown', last_test_result='unsupported' (NEVER 'unhealthy')
 *  - is_active is never touched by this cron (only the send path may disable accounts)
 *  - an account whose stored credentials cannot be decrypted becomes 'unknown' with a
 *    note and must not abort the loop for the remaining accounts.
 *
 * The route reads encrypted credential columns and must hand decrypted values to the
 * truthful test path (test-connection.ts), so seeds are encrypted with the test
 * MASTER_KEY exactly like production rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@timemark/shared/crypto';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  testConnection: vi.fn(),
  resolveEmailRecipientForTest: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: mocks.query,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../services/notifications/test-connection.js', () => ({
  testConnection: mocks.testConnection,
}));

vi.mock('../utils/notification-recipients.js', () => ({
  resolveEmailRecipientForTest: mocks.resolveEmailRecipientForTest,
}));

import cronRoutes from '../routes/cron.js';

const CRON_SECRET = 'channel-health-test-secret';
const MASTER_KEY = 'channel-health-test-master-key';

interface SeededAccount {
  id: number;
  user_id: number;
  type: string;
  webhook: string | null;
  token: string | null;
  secret: string | null;
  chat_id: string | null;
  config_method: string;
  is_active: boolean;
}

interface CapturedUpdate {
  sql: string;
  params: unknown[];
}

interface CronHealthBody {
  success: boolean;
  job: string;
  tested: number;
  ok: number;
  failed: number;
  unsupported: number;
}

let updates: CapturedUpdate[];
let logSummaries: string[];

function seed(
  id: number,
  type: string,
  configMethod: string,
  values: Partial<Pick<SeededAccount, 'webhook' | 'token' | 'secret' | 'chat_id'>> = {},
): SeededAccount {
  const enc = (v: string | null | undefined) => (v == null ? null : encrypt(v, MASTER_KEY));
  return {
    id,
    user_id: 1,
    type,
    config_method: configMethod,
    is_active: true,
    webhook: enc(values.webhook),
    token: enc(values.token),
    secret: enc(values.secret),
    chat_id: enc(values.chat_id),
  };
}

function mockQueries(rows: SeededAccount[]): void {
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM notification_accounts') && sql.includes('is_active = TRUE')) {
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('UPDATE notification_accounts')) {
      updates.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('cron_execution_logs')) {
      logSummaries.push(String(params?.[3] ?? ''));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function invokeChannelHealth(): Promise<{ status: number; body: CronHealthBody }> {
  const res = await cronRoutes.request('/channel-health', {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  return { status: res.status, body: (await res.json()) as CronHealthBody };
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.testConnection.mockReset();
  mocks.resolveEmailRecipientForTest.mockReset();
  updates = [];
  logSummaries = [];
  process.env.CRONSECRET = CRON_SECRET;
  delete process.env.CRON_SECRET;
  delete process.env.CRON_ALLOWED_IPS;
  delete process.env.HEALTHCHECK_URL;
  process.env.MASTER_KEY = MASTER_KEY;
  // Mirror the real helper: non-email channels keep their chatId.
  mocks.resolveEmailRecipientForTest.mockImplementation(
    async (_userId: number, _type: string, chatId?: string | null) => chatId ?? undefined,
  );
});

describe('GET /channel-health', () => {
  it('records healthy / unhealthy / unknown per category and never disables accounts', async () => {
    const rows = [
      seed(101, 'telegram', 'token', { token: '123456:good-token', chat_id: '123456' }),
      seed(102, 'slack', 'webhook', { webhook: 'https://hooks.slack.com/services/broken' }),
      seed(103, 'twilio', 'token', {
        token: 'ACxxxx',
        secret: 'auth-token',
        webhook: '+10000000000',
        chat_id: '+8613800138000',
      }),
    ];
    mockQueries(rows);

    mocks.testConnection.mockImplementation(async (config: { type: string }) => {
      if (config.type === 'telegram') return { success: true, message: '已连接到机器人' };
      if (config.type === 'slack') return { success: false, message: 'HTTP 404', details: '服务器地址可能不正确' };
      return { success: false, message: `暂不支持测试 ${config.type} 渠道` };
    });

    const { status, body } = await invokeChannelHealth();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      job: 'channel-health',
      tested: 3,
      ok: 1,
      failed: 1,
      unsupported: 1,
    });

    const byId = new Map(updates.map((u) => [u.params[2], u.params]));
    expect(byId.get(101)).toEqual(['healthy', 'success', 101]);
    expect(byId.get(102)).toEqual(['unhealthy', 'failed', 102]);
    expect(byId.get(103)).toEqual(['unknown', 'unsupported', 103]);

    expect(logSummaries).toContain('tested=3 ok=1 failed=1 unsupported=1');

    // The healthy account must be tested with DECRYPTED credentials, not ciphertext.
    const telegramCall = mocks.testConnection.mock.calls
      .map((call) => call[0] as { type: string; token?: string; chatId?: string })
      .find((config) => config.type === 'telegram');
    expect(telegramCall).toMatchObject({ token: '123456:good-token', chatId: '123456' });

    // No auto-disable: this cron must never write is_active.
    for (const update of updates) {
      expect(update.sql).not.toContain('is_active');
    }
    for (const row of rows) {
      expect(row.is_active).toBe(true);
    }
  });

  it('marks an undecryptable account unknown with a note and keeps going to the next account', async () => {
    const broken = seed(201, 'telegram', 'token', { token: 'placeholder', chat_id: '201' });
    broken.token = encrypt('123456:good-token', 'a-different-master-key');
    const rows = [broken, seed(202, 'telegram', 'token', { token: '123456:good-token', chat_id: '202' })];
    mockQueries(rows);
    mocks.testConnection.mockResolvedValue({ success: true, message: 'ok' });

    const { status, body } = await invokeChannelHealth();

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, tested: 2, ok: 1, failed: 0, unsupported: 1 });

    const byId = new Map(updates.map((u) => [u.params[2], u.params]));
    expect(byId.get(201)).toEqual(['unknown', 'decrypt_failed', 201]);
    expect(byId.get(202)).toEqual(['healthy', 'success', 202]);

    // The job never aborted: the second account was still tested with the real path.
    expect(mocks.testConnection).toHaveBeenCalledTimes(1);
    expect(mocks.testConnection.mock.calls[0][0]).toMatchObject({ type: 'telegram', token: '123456:good-token' });
  });

  it('does not crash the job when a status write is rejected (e.g. a CHECK constraint)', async () => {
    const rows = [
      seed(301, 'twilio', 'token', {
        token: 'ACxxxx',
        secret: 'auth-token',
        webhook: '+10000000000',
        chat_id: '+8613800138000',
      }),
    ];
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM notification_accounts') && sql.includes('is_active = TRUE')) {
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('UPDATE notification_accounts')) {
        throw new Error('new row for relation "notification_accounts" violates check constraint');
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.testConnection.mockResolvedValue({ success: false, message: '暂不支持测试 twilio 渠道' });

    const { status, body } = await invokeChannelHealth();

    // Unknown statuses must never take the whole cron down, even if the DB rejects them.
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, tested: 1, ok: 0, failed: 0, unsupported: 1 });
  });
});
