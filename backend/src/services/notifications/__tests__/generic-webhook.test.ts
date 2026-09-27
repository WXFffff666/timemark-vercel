import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.service.js', () => ({
  getUserConfig: vi.fn(),
  getRelationshipMappings: vi.fn(),
  getNotificationAccounts: vi.fn(),
  getEventTemplate: vi.fn(),
}));
vi.mock('../../../db/index.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));
vi.mock('../../email-log.service.js', () => ({
  logEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../notification-retry.service.js', () => ({
  enqueueNotificationRetry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../conflict-hint.service.js', () => ({
  getConflictHint: vi.fn().mockResolvedValue(null),
}));

import { sendNotifications } from '../index.js';
import {
  getEventTemplate,
  getNotificationAccounts,
  getRelationshipMappings,
  getUserConfig,
  type NotificationAccount,
} from '../../config.service.js';
import { query } from '../../../db/index.js';
import { startCaptureServer, type CaptureServer } from './test-utils.js';

function account(overrides: Partial<NotificationAccount> = {}): NotificationAccount {
  return {
    id: 7,
    user_id: 1,
    type: 'generic_webhook',
    name: 'Generic hook',
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

function reminderEvent(accountIds: number[], overrides: Record<string, unknown> = {}) {
  return {
    id: 4242,
    name: '妈妈生日',
    type: 'birthday',
    date: '2026-10-01',
    reminderConfig: {},
    personName: '妈妈',
    notification_account_ids: accountIds,
    ...overrides,
  };
}

describe('generic_webhook dispatch (bug B1)', () => {
  let server: CaptureServer;

  beforeAll(async () => {
    server = await startCaptureServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.requests.length = 0;
    vi.mocked(getUserConfig).mockResolvedValue({});
    vi.mocked(getRelationshipMappings).mockResolvedValue([]);
    vi.mocked(getEventTemplate).mockResolvedValue(null);
    vi.mocked(getNotificationAccounts).mockResolvedValue([]);
    vi.mocked(query).mockClear();
  });

  it('POSTs exactly once to the bound account webhook and reports success', async () => {
    const webhook = `${server.baseUrl}/generic-hook`;
    vi.mocked(getNotificationAccounts).mockResolvedValue([account({ webhook })]);

    const result = await sendNotifications(reminderEvent([7]), 1, ['generic_webhook']);

    expect(result.generic_webhook).toMatchObject({ success: true });
    expect(server.requests).toHaveLength(1);

    const request = server.requests[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/generic-hook');

    const body = request.json as { channel?: string; text?: string; title?: string } | null;
    expect(body).not.toBeNull();
    expect(body?.channel).toBe('generic_webhook');
    expect(body?.title).toContain('妈妈生日');
    expect(body?.text).toContain('妈妈生日');
  });

  it('reports no_configuration when the bound account has an empty webhook', async () => {
    vi.mocked(getNotificationAccounts).mockResolvedValue([account({ webhook: '' })]);

    const result = await sendNotifications(reminderEvent([7]), 1, ['generic_webhook']);

    expect(server.requests).toHaveLength(0);
    expect(result.generic_webhook).toEqual({ success: false, error: 'no_configuration' });
  });
});
