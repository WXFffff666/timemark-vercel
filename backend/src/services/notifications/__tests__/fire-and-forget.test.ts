import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 40 acceptance: inject a throwing DB into sendNotifications' retry-enqueue
 * path and assert that
 *   1. the top-level call still resolves and returns the channel result map,
 *   2. a structured log line with a STABLE `event` field was emitted,
 *   3. no promise became an unhandledRejection.
 */

const { mockPost, mockQuery } = vi.hoisted(() => ({
  mockPost: vi.fn<
    (url: string, data?: unknown, config?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>
  >(),
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('axios', () => ({ default: { post: mockPost, get: vi.fn() } }));
vi.mock('../../config.service.js', () => ({
  getUserConfig: vi.fn(),
  getRelationshipMappings: vi.fn(),
  getNotificationAccounts: vi.fn(),
  getEventTemplate: vi.fn(),
}));
vi.mock('../../../db/index.js', () => ({ query: mockQuery }));
vi.mock('../../email-log.service.js', () => ({
  logEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../conflict-hint.service.js', () => ({
  getConflictHint: vi.fn().mockResolvedValue(null),
}));
// NOTE: ../../notification-retry.service.js is deliberately NOT mocked — the real
// enqueueNotificationRetry runs and hits the throwing DB mock below.

import { sendNotifications } from '../index.js';
import {
  getEventTemplate,
  getNotificationAccounts,
  getRelationshipMappings,
  getUserConfig,
  type NotificationAccount,
} from '../../config.service.js';
import { logger } from '../../../utils/logger.js';

const RETRY_INSERT_MARKER = 'INSERT INTO notification_queue';
const STABLE_EVENT = 'notification.retry_enqueue_failed';

function account(overrides: Partial<NotificationAccount> & { id: number; type: string }): NotificationAccount {
  return {
    user_id: 1,
    name: overrides.type,
    webhook: null,
    token: null,
    secret: null,
    chat_id: null,
    is_active: true,
    config_method: 'webhook',
    session_data: null,
    plugin_package: null,
    connection_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function reminderEvent(accountIds: number[]) {
  return {
    id: 77,
    name: 'fire-and-forget 测试',
    type: 'birthday',
    date: '2026-10-01',
    reminderConfig: {},
    notification_account_ids: accountIds,
  };
}

describe('sendNotifications retry-enqueue failure handling (todo 40)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    vi.mocked(getUserConfig).mockResolvedValue({});
    vi.mocked(getRelationshipMappings).mockResolvedValue([]);
    vi.mocked(getEventTemplate).mockResolvedValue(null);
    vi.mocked(getNotificationAccounts).mockResolvedValue([
      account({
        id: 42,
        type: 'generic_webhook',
        webhook: 'https://hook.example.com/notify',
      }),
    ]);

    // A 4xx-style message keeps retryWithBackoff from sleeping between attempts.
    mockPost.mockRejectedValue(new Error('Request failed with status code 400'));

    // Throwing DB: every notification_queue INSERT rejects, everything else is a
    // harmless empty result (safe for trackConsecutiveFailure's SELECT).
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes(RETRY_INSERT_MARKER)) {
        throw new Error('db down (injected)');
      }
      return { rows: [], rowCount: 0 };
    });

    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    warnSpy = vi.spyOn(logger, 'warn');
  });

  afterEach(() => {
    process.removeListener('unhandledRejection', onUnhandled);
    warnSpy.mockRestore();
    mockPost.mockReset();
    mockQuery.mockReset();
  });

  it('resolves, returns the channel result map and logs the enqueue failure instead of crashing', async () => {
    const result = await sendNotifications(reminderEvent([42]), 1, ['generic_webhook']);

    // 1. Top-level resolved and returned the map with the failed channel entry.
    expect(result.generic_webhook).toMatchObject({
      success: false,
      error: 'Request failed with status code 400',
    });

    // 2. The retry-enqueue path was actually exercised against the throwing DB.
    const insertCalls = mockQuery.mock.calls.filter(([text]) => text.includes(RETRY_INSERT_MARKER));
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);

    // Let the fire-and-forget rejection handler run.
    await new Promise((resolve) => setImmediate(resolve));

    // 3. A structured log line with the stable event field was emitted.
    const calls = warnSpy.mock.calls as unknown as Array<[Record<string, unknown>, unknown]>;
    const enqueueLogs = calls.filter(([context]) => context.event === STABLE_EVENT);
    expect(enqueueLogs).toHaveLength(1);
    expect(enqueueLogs[0][0]).toMatchObject({ event: STABLE_EVENT });
    expect(enqueueLogs[0][0].err).toBeInstanceOf(Error);
    expect(String(enqueueLogs[0][1])).toContain('generic_webhook');

    // 4. No rejected promise escaped as an unhandledRejection.
    expect(unhandled).toEqual([]);
  });
});
