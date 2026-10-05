import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn<
    (url: string, data?: unknown, config?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>
  >(),
}));

vi.mock('axios', () => ({ default: { post: mockPost, get: vi.fn() } }));
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

import crypto from 'node:crypto';

import { sendNotifications } from '../index.js';
import {
  getEventTemplate,
  getNotificationAccounts,
  getRelationshipMappings,
  getUserConfig,
  type NotificationAccount,
} from '../../config.service.js';

// FCM service account 需要 RS256 PEM 私钥；用 webcrypto 按需生成一次
let FCM_SA = '';
let fcmKeyPromise: Promise<void> | null = null;
async function ensureFcmSa(): Promise<void> {
  if (FCM_SA) return;
  if (!fcmKeyPromise) {
    fcmKeyPromise = (async () => {
      const keyPair = await crypto.webcrypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      );
      const pkcs8 = await crypto.webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);
      const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n');
      const pem = ['-----BEGIN PRIVATE KEY-----', b64, '-----END PRIVATE KEY-----', ''].join('\n');
      FCM_SA = JSON.stringify({
        project_id: 'proj-dispatch',
        client_email: 'svc@proj-dispatch.iam.gserviceaccount.com',
        private_key: pem,
      });
    })();
  }
  await fcmKeyPromise;
}

const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const DISPATCHABLE = {
  serverchan3: 'https://7777.push.ft07.com/send/sctp7777tDISPATCH.send',
  xizhi: 'https://xizhi.qqoq.net/XZ_DISPATCH.send',
  anpush: 'https://api.anpush.com/push/ANPUSH_DISPATCH',
  chanify: `https://api.chanify.net/v1/sender/CHANIFY_DISPATCH?title=${encodeURIComponent('📅 全渠道联测')}&sound=1`,
  pushback: 'https://api.pushback.io/v1/send',
  simplepush: 'https://api.simplepush.io/send',
  zulip: 'https://dispatch.zulipchat.com/api/v1/messages',
  rocketchat: 'https://chat.example.com/hooks/DISPATCH_ID/DISPATCH_TOKEN',
  fcm: 'https://fcm.googleapis.com/v1/projects/proj-dispatch/messages:send',
  twilio_whatsapp: 'https://api.twilio.com/2010-04-01/Accounts/ACDISPATCH0000000000000000000000/Messages.json',
};

function account(overrides: Partial<NotificationAccount> & { id: number; type: string }): NotificationAccount {
  return {
    user_id: 1,
    name: overrides.type,
    webhook: null,
    token: null,
    secret: null,
    chat_id: null,
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
    id: 77,
    name: '全渠道联测',
    type: 'birthday',
    date: '2026-10-01',
    reminderConfig: {},
    notification_account_ids: accountIds,
  };
}

function mockProviderResponses(): void {
  mockPost.mockImplementation((url: string) => {
    if (url === FCM_TOKEN_URL) {
      return Promise.resolve({ status: 200, data: { access_token: ['ya29.', 'dispatch'].join(''), expires_in: 3600 } });
    }
    if (url.includes('xizhi.qqoq.net') || url.includes('api.anpush.com')) {
      return Promise.resolve({ status: 200, data: { code: 200, msg: 'ok' } });
    }
    if (url.includes('sct.ft07.com') || url.includes('push.ft07.com')) {
      return Promise.resolve({ status: 200, data: { code: 0, message: 'ok' } });
    }
    return Promise.resolve({ status: 200, data: { status: 'OK', result: 'success', success: true, name: 'projects/p/messages/1' } });
  });
}

describe('wave2 dispatch registration (checkboxes 15-22)', () => {
  beforeEach(() => {
    vi.mocked(getUserConfig).mockResolvedValue({});
    vi.mocked(getRelationshipMappings).mockResolvedValue([]);
    vi.mocked(getEventTemplate).mockResolvedValue(null);
    vi.mocked(getNotificationAccounts).mockResolvedValue([]);
    mockPost.mockReset();
  });

  it('resolves and sends through all 10 new channels via the main dispatch chain', async () => {
    await ensureFcmSa();
    vi.mocked(getNotificationAccounts).mockResolvedValue([
      account({ id: 1, type: 'serverchan3', token: 'sctp7777tDISPATCH' }),
      account({ id: 2, type: 'xizhi', token: 'XZ_DISPATCH' }),
      account({ id: 3, type: 'anpush', token: 'ANPUSH_DISPATCH', chat_id: 'CH_D' }),
      account({ id: 4, type: 'chanify', token: 'CHANIFY_DISPATCH', webhook: 'https://api.chanify.net' }),
      account({ id: 5, type: 'pushback', token: 'at_DISPATCH', chat_id: 'User_D' }),
      account({ id: 6, type: 'simplepush', token: 'SP_DISPATCH' }),
      account({
        id: 7,
        type: 'zulip',
        webhook: 'https://dispatch.zulipchat.com',
        token: 'ZK_DISPATCH',
        chat_id: 'bot@dispatch.zulipchat.com',
        secret: 'stream-dispatch',
      }),
      account({ id: 8, type: 'rocketchat', webhook: 'https://chat.example.com/hooks/DISPATCH_ID/DISPATCH_TOKEN', config_method: 'webhook' }),
      account({ id: 9, type: 'fcm', token: FCM_SA, chat_id: 'device-dispatch' }),
      account({
        id: 10,
        type: 'twilio_whatsapp',
        token: 'ACDISPATCH0000000000000000000000',
        secret: 'auth-dispatch',
        webhook: '+15005550006',
        chat_id: '+8613800138000',
      }),
    ]);
    mockProviderResponses();

    const channels = Object.keys(DISPATCHABLE);
    const result = await sendNotifications(reminderEvent([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 1, channels);

    for (const channel of channels) {
      expect(result[channel], `${channel} should succeed`).toMatchObject({ success: true });
    }
    const requestedUrls = mockPost.mock.calls.map(([url]) => String(url));
    for (const expectedUrl of Object.values(DISPATCHABLE)) {
      expect(requestedUrls, `missing request for ${expectedUrl}`).toContain(expectedUrl);
    }
  });

  it('v2.28: dispatches through the 5 new channels (pushbullet/join/pushsafer/webex/notifiarr)', async () => {
    vi.mocked(getNotificationAccounts).mockResolvedValue([
      account({ id: 1, type: 'pushbullet', token: 'PBT_DISPATCH' }),
      account({ id: 2, type: 'join', token: 'JOIN_DISPATCH', chat_id: 'DEV_D' }),
      account({ id: 3, type: 'pushsafer', token: 'PS_DISPATCH' }),
      account({ id: 4, type: 'webex', webhook: 'https://webexapis.com/v1/webhooks/incoming/WEBEX_D', config_method: 'webhook' }),
      account({ id: 5, type: 'notifiarr', webhook: 'https://notifiarr.com/api/v1/notification/passthrough/NOTIF_D', config_method: 'webhook' }),
    ]);
    mockProviderResponses();

    const result = await sendNotifications(reminderEvent([1, 2, 3, 4, 5]), 1, [
      'pushbullet', 'join', 'pushsafer', 'webex', 'notifiarr',
    ]);

    for (const channel of ['pushbullet', 'join', 'pushsafer', 'webex', 'notifiarr']) {
      expect(result[channel], `${channel} should succeed`).toMatchObject({ success: true });
    }
    const requestedUrls = mockPost.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.some((u) => u.includes('api.pushbullet.com/v2/pushes'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('joinjoaomgcd.appspot.com'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('pushsafer.com/api'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('webexapis.com/v1/webhooks/incoming/WEBEX_D'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('notifiarr.com/api/v1/notification/passthrough/NOTIF_D'))).toBe(true);
  });

  it('reports no_configuration (without any send) when a new channel account lacks required fields', async () => {
    await ensureFcmSa();
    vi.mocked(getNotificationAccounts).mockResolvedValue([
      account({ id: 1, type: 'fcm', token: FCM_SA, chat_id: null }),
      account({ id: 2, type: 'zulip', webhook: 'https://dispatch.zulipchat.com', token: 'ZK', chat_id: 'bot@x', secret: null }),
    ]);

    const result = await sendNotifications(reminderEvent([1, 2]), 1, ['fcm', 'zulip']);

    expect(result.fcm).toEqual({ success: false, error: 'no_configuration' });
    expect(result.zulip).toEqual({ success: false, error: 'no_configuration' });
    expect(mockPost).not.toHaveBeenCalled();
  });
});
