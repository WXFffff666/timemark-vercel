import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ status: 200, data: { ok: true } }) },
}));
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

import axios from 'axios';
import { sendNotifications } from '../index.js';
import {
  getEventTemplate,
  getNotificationAccounts,
  getRelationshipMappings,
  getUserConfig,
  type NotificationAccount,
} from '../../config.service.js';
import { query } from '../../../db/index.js';

function account(overrides: Partial<NotificationAccount> = {}): NotificationAccount {
  return {
    id: 1,
    user_id: 1,
    type: 'telegram',
    name: 'Telegram',
    webhook: null,
    token: '123:ABC',
    secret: null,
    chat_id: '99',
    is_active: true,
    config_method: 'token',
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
    id: 55,
    name: '结婚纪念日',
    type: 'anniversary',
    date: '2026-10-01',
    reminderConfig: {},
    notification_account_ids: accountIds,
  };
}

describe('sendNotifications unresolved channel reporting (checkbox 12)', () => {
  beforeEach(() => {
    vi.mocked(getUserConfig).mockResolvedValue({});
    vi.mocked(getRelationshipMappings).mockResolvedValue([]);
    vi.mocked(getEventTemplate).mockResolvedValue(null);
    vi.mocked(getNotificationAccounts).mockResolvedValue([]);
    vi.mocked(query).mockClear();
    vi.mocked(axios.post).mockClear();
  });

  it('reports every requested channel and marks unresolved ones as no_configuration', async () => {
    vi.mocked(getNotificationAccounts).mockResolvedValue([account()]);

    const result = await sendNotifications(reminderEvent([1]), 1, ['telegram', 'generic_webhook']);

    expect(Object.keys(result).sort()).toEqual(['generic_webhook', 'telegram']);
    expect(result.telegram).toMatchObject({ success: true });
    expect(result.generic_webhook).toEqual({ success: false, error: 'no_configuration' });
    expect(result.generic_webhook?.accountId).toBeUndefined();
    expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(1);
  });

  it('does not run the consecutive-failure tracker for a no_configuration entry', async () => {
    vi.mocked(getNotificationAccounts).mockResolvedValue([account()]);

    await sendNotifications(reminderEvent([1]), 1, ['telegram', 'generic_webhook']);

    // trackConsecutiveFailure's first DB statement is the event_trigger_logs count
    const sqlStatements = vi.mocked(query).mock.calls.map(([sql]) => String(sql));
    expect(sqlStatements.some((sql) => sql.includes('event_trigger_logs'))).toBe(false);
  });

  it('reports requested channels that are unsupported on serverless', async () => {
    const result = await sendNotifications(reminderEvent([]), 1, ['whatsapp']);

    expect(result.whatsapp).toEqual({ success: false, error: 'unsupported_channel' });
    expect(result._skipped).toEqual({ success: false, error: 'no_supported_channels' });
  });

  it('reports an unsupported channel in a MIXED request instead of omitting it', async () => {
    vi.mocked(getNotificationAccounts).mockResolvedValue([account()]);

    const result = await sendNotifications(reminderEvent([1]), 1, ['telegram', 'whatsapp']);

    expect(Object.keys(result).sort()).toEqual(['telegram', 'whatsapp']);
    expect(result.telegram).toMatchObject({ success: true });
    expect(result.whatsapp).toEqual({ success: false, error: 'unsupported_channel' });
  });

  it('does not trigger a fallback send for an unsupported_channel entry', async () => {
    vi.mocked(getNotificationAccounts).mockResolvedValue([
      account(),
      account({
        id: 2,
        type: 'discord',
        name: 'Discord',
        webhook: 'https://discord.com/api/webhooks/x',
        token: null,
        chat_id: null,
        config_method: 'webhook',
      }),
    ]);

    const result = await sendNotifications(reminderEvent([1]), 1, ['telegram', 'whatsapp']);

    expect(result.whatsapp).toEqual({ success: false, error: 'unsupported_channel' });
    // Only the telegram send happened — the unsupported id must not be recovered via another account.
    expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(1);
  });

  it('keeps the _skipped sentinel unchanged for an empty channel list', async () => {
    const result = await sendNotifications(reminderEvent([]), 1, []);

    expect(result).toEqual({ _skipped: { success: false, error: 'no_supported_channels' } });
  });
});
