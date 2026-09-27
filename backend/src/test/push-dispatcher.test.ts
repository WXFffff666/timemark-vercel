import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 84 acceptance — the `web_push` channel inside the EXISTING
 * notification dispatcher.
 *
 * - subscriptions resolve from `push_subscriptions` (not notification_accounts)
 * - a missing VAPID key skips the channel (`no_configuration`), never throws
 * - a 410/404 removes the row AND enqueues NO retry entry (no retry loop)
 * - a transient failure DOES enqueue a retry (contrast case)
 */

const { dbQuery, sendNotification, setVapidDetails, enqueueRetry } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
  enqueueRetry: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: {
    sendNotification,
    setVapidDetails,
    generateVAPIDKeys: vi.fn(),
  },
}));

vi.mock('../services/config.service.js', () => ({
  getUserConfig: vi.fn(),
  getRelationshipMappings: vi.fn(),
  getNotificationAccounts: vi.fn(),
  getEventTemplate: vi.fn(),
}));

vi.mock('../services/email-log.service.js', () => ({
  logEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/notification-retry.service.js', () => ({
  enqueueNotificationRetry: enqueueRetry,
}));

vi.mock('../services/conflict-hint.service.js', () => ({
  getConflictHint: vi.fn().mockResolvedValue(null),
}));

import { sendNotifications } from '../services/notifications/index.js';
import {
  getEventTemplate,
  getNotificationAccounts,
  getRelationshipMappings,
  getUserConfig,
} from '../services/config.service.js';

const USER_ID = 1;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dispatcher-endpoint';

interface StoredRow {
  user_id: number;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
}

let storedRows: StoredRow[];

function event() {
  return {
    id: 55,
    name: '结婚纪念日',
    type: 'anniversary',
    date: '2026-10-01',
    reminderConfig: {},
  };
}

function installDb(): void {
  storedRows = [
    {
      user_id: USER_ID,
      endpoint: ENDPOINT,
      keys_p256dh: 'p256dh-stored',
      keys_auth: 'auth-stored',
    },
  ];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions')) {
      const [userId] = params as [number];
      return { rows: storedRows.filter((row) => row.user_id === userId), rowCount: 0 };
    }
    if (sql.includes('DELETE FROM push_subscriptions')) {
      const [userId, endpoint] = params as [number, string];
      storedRows = storedRows.filter(
        (row) => !(row.user_id === userId && row.endpoint === endpoint),
      );
      return { rows: [], rowCount: 1 };
    }
    // event_trigger_logs / profile routes / anything else the dispatcher probes.
    return { rows: [], rowCount: 0 };
  });
}

function setVapidEnv(): void {
  process.env.PUSH_VAPID_PUBLIC_KEY = 'dispatcher-vapid-public';
  process.env.PUSH_VAPID_PRIVATE_KEY = 'dispatcher-vapid-private';
}

describe('web_push dispatcher channel (checkbox 84)', () => {
  beforeEach(() => {
    installDb();
    sendNotification.mockReset();
    setVapidDetails.mockReset();
    enqueueRetry.mockReset();
    enqueueRetry.mockResolvedValue(undefined);
    vi.mocked(getUserConfig).mockResolvedValue({});
    vi.mocked(getRelationshipMappings).mockResolvedValue([]);
    vi.mocked(getEventTemplate).mockResolvedValue(null);
    vi.mocked(getNotificationAccounts).mockResolvedValue([]);
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;
    delete process.env.PUSH_VAPID_SUBJECT;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    setVapidEnv();
  });

  afterEach(() => {
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;
    delete process.env.PUSH_VAPID_SUBJECT;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  it('sends through web_push: stored subscription + VAPID details + event payload', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });

    const result = await sendNotifications(event(), USER_ID, ['web_push']);

    expect(result.web_push).toMatchObject({ success: true });
    expect(setVapidDetails).toHaveBeenCalledWith(
      'mailto:admin@timemark.app',
      'dispatcher-vapid-public',
      'dispatcher-vapid-private',
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [subscription, payload] = sendNotification.mock.calls[0] as [Record<string, unknown>, string];
    expect(subscription).toEqual({
      endpoint: ENDPOINT,
      keys: { p256dh: 'p256dh-stored', auth: 'auth-stored' },
    });
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.title).toBe('结婚纪念日');
    expect(parsed.url).toContain('/reminders?event=55');
  });

  it('fails open when VAPID is missing: no_configuration, no send, no throw', async () => {
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;

    const result = await sendNotifications(event(), USER_ID, ['web_push']);

    expect(result.web_push).toEqual({ success: false, error: 'no_configuration' });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(enqueueRetry).not.toHaveBeenCalled();
  });

  it('reports no_configuration when the user has no subscriptions (never throws)', async () => {
    storedRows = [];
    const result = await sendNotifications(event(), USER_ID, ['web_push']);
    expect(result.web_push).toEqual({ success: false, error: 'no_configuration' });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('a 410 DELETES the row and creates NO retry queue entry', async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error('Gone'), { statusCode: 410 }));

    const result = await sendNotifications(event(), USER_ID, ['web_push']);

    expect(storedRows).toHaveLength(0);
    const deleteCall = dbQuery.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM push_subscriptions'));
    expect(deleteCall?.[1]).toEqual([USER_ID, ENDPOINT]);
    expect(enqueueRetry).not.toHaveBeenCalled();
    // Removed-only delivery is not a failure: nothing is left to retry.
    expect(result.web_push).toMatchObject({ success: true });
  });

  it('a transient failure DOES enqueue a retry (contrast with 410)', async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error('push outage'), { statusCode: 500 }));

    const result = await sendNotifications(event(), USER_ID, ['web_push']);

    expect(storedRows).toHaveLength(1);
    expect(result.web_push).toMatchObject({ success: false });
    expect(enqueueRetry).toHaveBeenCalledTimes(1);
    expect(enqueueRetry).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 55, userId: USER_ID, channel: 'web_push' }),
    );
  });
});
