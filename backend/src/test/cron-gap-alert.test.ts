import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 166 (wave 19): the EXISTING B29 cron-gap alert (>3 min) still works, and it now
 * shares the `CRON_GAP_ALERT_MINUTES` constant with the catch-up log in `jobs/tasks.ts`
 * (the catch-up REUSES the alert's signal instead of adding a second alert mechanism).
 *
 * `checkCronGapAlert` is exported so this suite can drive it directly over a mocked query.
 */

interface InboxMessage {
  userId: number;
  title: string;
  body: string;
  source: string;
}

const mocks = vi.hoisted(() => {
  const logs = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const makeLogger = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'child') return makeLogger;
          if (prop in logs) return logs[prop as keyof typeof logs];
          return () => undefined;
        },
      },
    );
  return {
    query: vi.fn(),
    logs,
    makeLogger,
    createInboxMessage: vi.fn(async (_message: InboxMessage) => undefined),
    STATE: { prevExecutedAt: null as string | null, adminUserId: 1 as number | null },
  };
});

vi.mock('../db/index.js', () => ({
  query: mocks.query,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => mocks.makeLogger(),
  createLoggerInstance: () => mocks.makeLogger(),
  logger: mocks.makeLogger(),
  logFireAndForget: () => () => undefined,
  runWithRequestLog: (_context: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../services/inbox.service.js', () => ({
  createInboxMessage: mocks.createInboxMessage,
}));

import { checkCronGapAlert } from '../routes/cron.js';
import { CRON_GAP_ALERT_MINUTES } from '../jobs/tasks.js';

beforeEach(() => {
  mocks.createInboxMessage.mockReset();
  mocks.createInboxMessage.mockResolvedValue(undefined);
  mocks.STATE.prevExecutedAt = null;
  mocks.STATE.adminUserId = 1;
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT executed_at FROM cron_execution_logs')) {
      return mocks.STATE.prevExecutedAt
        ? { rows: [{ executed_at: mocks.STATE.prevExecutedAt }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM user_configs WHERE alert_channels')) {
      return mocks.STATE.adminUserId === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ user_id: mocks.STATE.adminUserId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});

function minutesAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe('checkCronGapAlert - existing >3 minute gap alert', () => {
  it('still fires exactly one inbox alert for a 5-minute gap', async () => {
    mocks.STATE.prevExecutedAt = minutesAgo(5 * 60_000);
    await checkCronGapAlert('reminder-check');

    expect(mocks.createInboxMessage).toHaveBeenCalledTimes(1);
    const call = mocks.createInboxMessage.mock.calls[0][0];
    expect(call.userId).toBe(1);
    expect(call.title).toBe('Cron 执行间隔异常');
    expect(call.body).toContain('reminder-check');
    expect(call.body).toContain('5');
    expect(call.source).toBe('broadcast');
  });

  it('does NOT alert for a healthy gap (2 minutes)', async () => {
    mocks.STATE.prevExecutedAt = minutesAgo(2 * 60_000);
    await checkCronGapAlert('reminder-check');
    expect(mocks.createInboxMessage).not.toHaveBeenCalled();
  });

  it('alerts strictly above the shared CRON_GAP_ALERT_MINUTES threshold (boundary)', async () => {
    mocks.STATE.prevExecutedAt = minutesAgo(CRON_GAP_ALERT_MINUTES * 60_000 + 5_000);
    await checkCronGapAlert('reminder-check');
    expect(mocks.createInboxMessage).toHaveBeenCalledTimes(1);

    mocks.createInboxMessage.mockReset();
    mocks.STATE.prevExecutedAt = minutesAgo(CRON_GAP_ALERT_MINUTES * 60_000 - 5_000);
    await checkCronGapAlert('reminder-check');
    expect(mocks.createInboxMessage).not.toHaveBeenCalled();
  });

  it('stays advisory: no previous success row -> no alert, no throw', async () => {
    mocks.STATE.prevExecutedAt = null;
    await expect(checkCronGapAlert('reminder-check')).resolves.toBeUndefined();
    expect(mocks.createInboxMessage).not.toHaveBeenCalled();
  });

  it('stays advisory: no admin alert_channels row -> no alert, no throw', async () => {
    mocks.STATE.prevExecutedAt = minutesAgo(10 * 60_000);
    mocks.STATE.adminUserId = null;
    await expect(checkCronGapAlert('reminder-check')).resolves.toBeUndefined();
    expect(mocks.createInboxMessage).not.toHaveBeenCalled();
  });
});
