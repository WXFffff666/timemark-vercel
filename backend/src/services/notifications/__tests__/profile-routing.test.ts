import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 70 acceptance, part 1: per-profile notification routing.
 *
 * A profile's explicit `profile_channel_accounts` rows decide WHICH accounts a
 * reminder may use. No rows -> all active accounts (the pre-routing behaviour).
 * An explicit per-event `notification_account_ids` binding stays authoritative.
 *
 * Observable proof (misleading_success_output): with profile B routed to account
 * 2 only, account 1 must NOT receive anything. If the dispatcher ignored routing
 * and always used all accounts, `sendTelegramNotification` would be called twice
 * and these assertions fail.
 */

vi.mock('axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ status: 200, data: { ok: true } }) },
}));
vi.mock('../../config.service.js', () => ({
  getUserConfig: vi.fn(),
  getRelationshipMappings: vi.fn(),
  getNotificationAccounts: vi.fn(),
  getEventTemplate: vi.fn(),
}));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock('../../../db/index.js', () => ({
  query: dbQuery,
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
vi.mock('../telegram.service.js', () => ({
  sendTelegramNotification: vi.fn().mockResolvedValue(undefined),
}));

import { sendNotifications } from '../index.js';
import {
  getEventTemplate,
  getNotificationAccounts,
  getRelationshipMappings,
  getUserConfig,
  type NotificationAccount,
} from '../../config.service.js';
import { sendTelegramNotification } from '../telegram.service.js';

function account(overrides: Partial<NotificationAccount> = {}): NotificationAccount {
  return {
    id: 1,
    user_id: 1,
    type: 'telegram',
    name: 'Telegram A',
    webhook: null,
    token: '111:AAA',
    secret: null,
    chat_id: '11',
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

/** No notification_account_ids -> the default (all eligible accounts) resolution runs. */
function profileEvent(profileId: number | null) {
  return {
    id: 77,
    user_id: 1,
    name: '妈妈生日',
    type: 'birthday',
    date: '2026-10-01',
    calendar_type: 'gregorian',
    reminderConfig: {},
    reminder_config: null,
    profile_id: profileId,
  };
}

const A = account();
const B = account({ id: 2, name: 'Telegram B', token: '222:BBB', chat_id: '22' });

function routingRows(accountIds: number[]): void {
  dbQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('profile_channel_accounts')) {
      return { rows: accountIds.map((account_id) => ({ account_id })), rowCount: accountIds.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('per-profile notification routing (checkbox 70)', () => {
  beforeEach(() => {
    vi.mocked(getUserConfig).mockResolvedValue({});
    vi.mocked(getRelationshipMappings).mockResolvedValue([]);
    vi.mocked(getEventTemplate).mockResolvedValue(null);
    vi.mocked(getNotificationAccounts).mockResolvedValue([A, B]);
    vi.mocked(sendTelegramNotification).mockClear();
    dbQuery.mockReset();
    routingRows([]);
  });

  it('delivers only to the accounts explicitly routed to the event profile', async () => {
    routingRows([2]); // profile 12 -> account 2 only

    const result = await sendNotifications(profileEvent(12), 1, ['telegram'], { profileId: 12 });

    expect(result.telegram).toMatchObject({ success: true });
    expect(vi.mocked(sendTelegramNotification)).toHaveBeenCalledTimes(1);
    const [, token, chatId] = vi.mocked(sendTelegramNotification).mock.calls[0];
    expect(token).toBe('222:BBB');
    expect(chatId).toBe('22');
  });

  it('falls back to ALL active accounts when the profile has no routing rows', async () => {
    routingRows([]); // no explicit routing for profile 12

    const result = await sendNotifications(profileEvent(12), 1, ['telegram'], { profileId: 12 });

    expect(result.telegram).toMatchObject({ success: true });
    expect(vi.mocked(sendTelegramNotification)).toHaveBeenCalledTimes(2);
    const tokens = vi.mocked(sendTelegramNotification).mock.calls.map(([, token]) => token).sort();
    expect(tokens).toEqual(['111:AAA', '222:BBB']);
  });

  it('does not consult profile routing when no profile context is given (backwards compatible)', async () => {
    await sendNotifications(profileEvent(null), 1, ['telegram']);

    expect(vi.mocked(sendTelegramNotification)).toHaveBeenCalledTimes(2);
    expect(
      dbQuery.mock.calls.some(([sql]) => String(sql).includes('profile_channel_accounts')),
    ).toBe(false);
  });

  it('keeps an explicit per-event account binding authoritative even when the profile routes elsewhere', async () => {
    routingRows([2]); // profile 12 -> account 2
    const event = { ...profileEvent(12), notification_account_ids: [1] }; // explicit binding -> account 1

    await sendNotifications(event, 1, ['telegram'], { profileId: 12 });

    expect(vi.mocked(sendTelegramNotification)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelegramNotification).mock.calls[0][1]).toBe('111:AAA');
  });

  it('treats a non-existent / foreign profile id as "no routing rows" (no leak, all accounts)', async () => {
    routingRows([]); // resolver JOINs profiles on user_id -> foreign profiles yield zero rows

    await sendNotifications(profileEvent(999), 1, ['telegram'], { profileId: 999 });

    expect(vi.mocked(sendTelegramNotification)).toHaveBeenCalledTimes(2);
    // The lookup is scoped to the current user, never a global profile lookup.
    const routingCall = dbQuery.mock.calls.find(([sql]) => String(sql).includes('profile_channel_accounts'));
    expect(routingCall).toBeDefined();
    expect(String(routingCall![0])).toContain('p.user_id = $2');
  });
});
