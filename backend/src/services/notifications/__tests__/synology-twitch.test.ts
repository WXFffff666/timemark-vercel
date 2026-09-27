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
import { startCaptureServer, type CaptureServer } from './test-utils.js';

function account(type: string, webhook: string): NotificationAccount {
  return {
    id: 9,
    user_id: 1,
    type,
    name: type,
    webhook,
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
  };
}

describe('synologychat / twitch use their dedicated senders', () => {
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
  });

  it('synologychat POSTs form-encoded payload=<json>, not raw JSON and not the generic body', async () => {
    vi.mocked(getNotificationAccounts).mockResolvedValue([account('synologychat', `${server.baseUrl}/synology-hook`)]);

    const result = await sendNotifications(
      { id: 77, name: '体检', type: 'medical', date: '2026-11-01', reminderConfig: {}, notification_account_ids: [9] },
      1,
      ['synologychat'],
    );

    expect(result.synologychat).toMatchObject({ success: true });
    expect(server.requests).toHaveLength(1);

    const request = server.requests[0];
    expect(String(request.headers['content-type'])).toContain('application/x-www-form-urlencoded');

    const params = new URLSearchParams(request.body);
    const rawPayload = params.get('payload');
    expect(rawPayload).not.toBeNull();
    const payload = JSON.parse(String(rawPayload)) as { text?: string; channel?: string; event?: unknown };
    expect(payload.text).toContain('体检');
    expect(payload.channel).toBeUndefined();
    expect(payload.event).toBeUndefined();
  });

  it('twitch POSTs the dedicated { content, username } payload, not the generic webhook body', async () => {
    vi.mocked(getNotificationAccounts).mockResolvedValue([account('twitch', `${server.baseUrl}/twitch-hook`)]);

    const result = await sendNotifications(
      { id: 78, name: '直播提醒', type: 'other', date: '2026-11-02', reminderConfig: {}, notification_account_ids: [9] },
      1,
      ['twitch'],
    );

    expect(result.twitch).toMatchObject({ success: true });
    expect(server.requests).toHaveLength(1);
    const body = server.requests[0].json as { content?: string; username?: string; channel?: string } | null;
    expect(body?.content).toContain('直播提醒');
    expect(body?.username).toBe('TimeMark Bot');
    expect(body?.channel).toBeUndefined();
  });
});
