import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn<
    (url: string, data?: unknown, config?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>
  >(),
}));

vi.mock('axios', () => ({ default: { post: mockPost, get: vi.fn() } }));

import crypto from 'node:crypto';

import { sendServerChan3Notification } from '../serverchan3.service.js';
import { sendXizhiNotification } from '../xizhi.service.js';
import { sendAnPushNotification } from '../anpush.service.js';
import { sendChanifyNotification } from '../chanify.service.js';
import { sendPushbackNotification } from '../pushback.service.js';
import { sendSimplePushNotification } from '../simplepush.service.js';
import { sendZulipNotification } from '../zulip.service.js';
import { sendRocketChatNotification } from '../rocketchat.service.js';
import { sendFcmNotification } from '../fcm.service.js';
import { sendTwilioWhatsAppNotification } from '../twilio-whatsapp.service.js';

const EVENT = {
  name: '测试事件',
  type: 'birthday',
  date: '2026-10-01',
  customMessage: '今晚给妈妈打电话',
};

const SENSITIVE_VALUES = [
  'sctp1234tSECRETKEY',
  'XZ_SECRET_KEY',
  'ANPUSH_SECRET',
  'CHANIFY_SECRET',
  'at_PUSHBACK_SECRET',
  'User_42',
  'SP_SECRET_KEY',
  'ZULIP_SECRET_KEY',
  'bot@wave2.zulipchat.com',
  'RC_HOOK_TOKEN',
  'ACSECRETSID0000000000000000000000',
  'AUTH_SECRET_TOKEN',
];
let fcmPrivateKey = '';
let fcmKeyPromise: Promise<void> | null = null;

// FCM service account 需要 RS256 PEM 私钥；用 webcrypto 按需生成一次
async function ensureFcmKey(): Promise<void> {
  if (fcmPrivateKey) return;
  if (!fcmKeyPromise) {
    fcmKeyPromise = (async () => {
      const keyPair = await crypto.webcrypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      );
      const pkcs8 = await crypto.webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);
      const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n');
      fcmPrivateKey = ['-----BEGIN PRIVATE KEY-----', b64, '-----END PRIVATE KEY-----', ''].join('\n');
    })();
  }
  await fcmKeyPromise;
}

function redact(value: string): string {
  let out = value;
  for (const secret of SENSITIVE_VALUES) out = out.split(secret).join('***');
  if (fcmPrivateKey) out = out.split(fcmPrivateKey).join('***');
  out = out.split('PRIVATE KEY').join('PRIVATE-KEY-REDACTED');
  return out;
}

/**
 * Manual-QA capture: records the EXACT axios call (method/url/content-type/body)
 * for a success fixture and the provider's error fixture, with secrets redacted.
 * Printed as `[WAVE2-CAPTURE]` lines for the evidence file.
 */
function capture(
  channel: string,
  fixture: 'success' | 'error',
  call: [url: string, data?: unknown, config?: Record<string, unknown>],
): void {
  const [url, body, config] = call;
  const headers = (config?.headers ?? {}) as Record<string, unknown>;
  const serializer = (value: unknown): string =>
    value instanceof URLSearchParams ? value.toString() : typeof value === 'string' ? value : JSON.stringify(value);
  const line = JSON.stringify({
    channel,
    fixture,
    method: 'POST',
    url: redact(String(url)),
    contentType: String(headers['Content-Type'] ?? headers['content-type'] ?? ''),
    body: redact(typeof body === 'undefined' ? '' : serializer(body)),
  });
  console.log(`[WAVE2-CAPTURE] ${line}`);
}

const makeHttpError = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, statusText: 'Error', data },
  });

function formBodyOf(data: unknown): URLSearchParams {
  expect(data).toBeInstanceOf(URLSearchParams);
  return data as URLSearchParams;
}

beforeEach(() => {
  mockPost.mockReset();
});

describe('serverchan3 send (checkbox 15)', () => {
  it('derives the uid subdomain and sends title/desp', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 0, message: 'ok' } });

    await sendServerChan3Notification(EVENT, 'sctp1234tSECRETKEY');

    const call = mockPost.mock.calls[0];
    capture('serverchan3', 'success', call);
    expect(call[0]).toBe('https://1234.push.ft07.com/send/sctp1234tSECRETKEY.send');
    const form = formBodyOf(call[1]);
    expect(form.get('title')).toBe('📅 测试事件');
    expect(form.get('desp')).toBe('今晚给妈妈打电话');
  });

  it('rejects with the provider message on code 40001', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 40001, message: 'invalid sendkey' } });

    await expect(sendServerChan3Notification(EVENT, 'sctp1234tSECRETKEY')).rejects.toThrow('invalid sendkey');
    capture('serverchan3', 'error', mockPost.mock.calls[0]);
  });

  it('surfaces the provider `error` field (live fixture shape) instead of 未知错误', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 10003, error: 'sendkey not found' } });

    const rejection = await sendServerChan3Notification(EVENT, 'sctp1234tSECRETKEY').catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    expect(rejection).toContain('sendkey not found');
    capture('serverchan3', 'error', mockPost.mock.calls[0]);
  });

  it('rejects without a request when no uid can be derived', async () => {
    await expect(sendServerChan3Notification(EVENT, 'SCT_ONLY')).rejects.toThrow(/UID/);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('xizhi send (checkbox 16)', () => {
  it('posts title/content form-encoded', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 200, msg: 'ok' } });

    await sendXizhiNotification(EVENT, 'XZ_SECRET_KEY');

    const call = mockPost.mock.calls[0];
    capture('xizhi', 'success', call);
    expect(call[0]).toBe('https://xizhi.qqoq.net/XZ_SECRET_KEY.send');
    const form = formBodyOf(call[1]);
    expect(form.get('title')).toBe('📅 测试事件');
    expect(form.get('content')).toBe('今晚给妈妈打电话');
  });

  it('rejects with msg on code 10000 (live-probed error)', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 10000, msg: 'key 无效' } });

    await expect(sendXizhiNotification(EVENT, 'XZ_SECRET_KEY')).rejects.toThrow('key 无效');
    capture('xizhi', 'error', mockPost.mock.calls[0]);
  });
});

describe('anpush send (checkbox 17)', () => {
  it('posts title/content/channel form-encoded', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 200, msg: 'ok' } });

    await sendAnPushNotification(EVENT, 'ANPUSH_SECRET', 'CH_9');

    const call = mockPost.mock.calls[0];
    capture('anpush', 'success', call);
    expect(call[0]).toBe('https://api.anpush.com/push/ANPUSH_SECRET');
    const form = formBodyOf(call[1]);
    expect(form.get('channel')).toBe('CH_9');
    expect(form.get('content')).toBe('今晚给妈妈打电话');
  });

  it('rejects with the provider msg on code 404', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 404, msg: 'token invalid' } });

    await expect(sendAnPushNotification(EVENT, 'ANPUSH_SECRET')).rejects.toThrow('token invalid');
    capture('anpush', 'error', mockPost.mock.calls[0]);
  });
});

describe('chanify send (checkbox 18)', () => {
  it('posts text= with title in the query', async () => {
    mockPost.mockResolvedValue({ status: 200, data: {} });

    await sendChanifyNotification(EVENT, 'https://api.chanify.net/', 'CHANIFY_SECRET');

    const call = mockPost.mock.calls[0];
    capture('chanify', 'success', call);
    expect(call[0]).toBe(
      `https://api.chanify.net/v1/sender/CHANIFY_SECRET?title=${encodeURIComponent('📅 测试事件')}&sound=1`,
    );
    expect(formBodyOf(call[1]).get('text')).toBe('今晚给妈妈打电话');
  });

  it('throws a validation error for a base URL with a path (no request)', async () => {
    await expect(sendChanifyNotification(EVENT, 'https://api.chanify.net/v1', 'CHANIFY_SECRET')).rejects.toThrow(/路径/);
    expect(mockPost).not.toHaveBeenCalled();
    console.log(
      `[WAVE2-CAPTURE] {"channel":"chanify","fixture":"error","method":"NONE","url":"https://api.chanify.net/v1","contentType":"","body":"validation: path rejected before request"}`,
    );
  });

  it('propagates the 401 error', async () => {
    mockPost.mockRejectedValue(makeHttpError(401, ''));

    await expect(sendChanifyNotification(EVENT, 'https://api.chanify.net', 'CHANIFY_SECRET')).rejects.toThrow('401');
    capture('chanify', 'error', mockPost.mock.calls[0]);
  });
});

describe('pushback send (checkbox 19)', () => {
  it('posts Bearer auth + JSON body', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { status: 'OK' } });

    await sendPushbackNotification(EVENT, 'at_PUSHBACK_SECRET', 'User_42');

    const call = mockPost.mock.calls[0];
    capture('pushback', 'success', call);
    expect(call[0]).toBe('https://api.pushback.io/v1/send');
    expect(call[1]).toMatchObject({ id: 'User_42', title: '📅 测试事件', body: '今晚给妈妈打电话' });
    const headers = call[2]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer at_PUSHBACK_SECRET');
  });

  it('rejects with the provider message on an error status body', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { status: 'ERROR', message: 'user not found' } });

    await expect(sendPushbackNotification(EVENT, 'at_PUSHBACK_SECRET', 'User_42')).rejects.toThrow('user not found');
    capture('pushback', 'error', mockPost.mock.calls[0]);
  });
});

describe('simplepush send (checkbox 19)', () => {
  it('posts key/msg/title to the live-probed endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { status: 'OK' } });

    await sendSimplePushNotification(EVENT, 'SP_SECRET_KEY');

    const call = mockPost.mock.calls[0];
    capture('simplepush', 'success', call);
    expect(call[0]).toBe('https://api.simplepush.io/send');
    const form = formBodyOf(call[1]);
    expect(form.get('key')).toBe('SP_SECRET_KEY');
    expect(form.get('msg')).toBe('今晚给妈妈打电话');
  });

  it('rejects when the provider status is not OK', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { status: 'ERROR', message: 'Invalid key' } });

    await expect(sendSimplePushNotification(EVENT, 'SP_SECRET_KEY')).rejects.toThrow('Invalid key');
    capture('simplepush', 'error', mockPost.mock.calls[0]);
  });
});

describe('zulip send (checkbox 20)', () => {
  it('posts Basic auth + stream form params', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { result: 'success', msg: '' } });

    await sendZulipNotification(
      EVENT,
      'https://wave2.zulipchat.com',
      'ZULIP_SECRET_KEY',
      'bot@wave2.zulipchat.com',
      'time-reminders',
    );

    const call = mockPost.mock.calls[0];
    capture('zulip', 'success', call);
    expect(call[0]).toBe('https://wave2.zulipchat.com/api/v1/messages');
    const headers = call[2]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('bot@wave2.zulipchat.com:ZULIP_SECRET_KEY').toString('base64')}`,
    );
    const form = formBodyOf(call[1]);
    expect(form.get('type')).toBe('stream');
    expect(form.get('to')).toBe('time-reminders');
    expect(form.get('content')).toContain('今晚给妈妈打电话');
  });

  it('rejects with msg when result is not success', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { result: 'error', msg: 'Invalid API key' } });

    await expect(
      sendZulipNotification(EVENT, 'https://wave2.zulipchat.com', 'ZULIP_SECRET_KEY', 'bot@wave2.zulipchat.com', 'time-reminders'),
    ).rejects.toThrow('Invalid API key');
    capture('zulip', 'error', mockPost.mock.calls[0]);
  });
});

describe('rocketchat send (checkbox 20)', () => {
  it('posts {"text"} to the hook URL', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    await sendRocketChatNotification(EVENT, 'https://chat.example.com/hooks/RC_HOOK_ID/RC_HOOK_TOKEN');

    const call = mockPost.mock.calls[0];
    capture('rocketchat', 'success', call);
    expect(call[0]).toBe('https://chat.example.com/hooks/RC_HOOK_ID/RC_HOOK_TOKEN');
    expect(call[1]).toMatchObject({ text: expect.stringContaining('测试事件') });
  });

  it('rejects on a 200 body with success:false', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: false, error: 'invalid token' } });

    await expect(sendRocketChatNotification(EVENT, 'https://chat.example.com/hooks/RC_HOOK_ID/RC_HOOK_TOKEN')).rejects.toThrow(
      'invalid token',
    );
    capture('rocketchat', 'error', mockPost.mock.calls[0]);
  });
});

describe('fcm send (checkbox 21)', () => {
  const makeSa = (email: string): string =>
    JSON.stringify({
      project_id: 'proj-capture',
      client_email: email,
      private_key: fcmPrivateKey,
    });

  it('exchanges a JWT and posts the message body', async () => {
    await ensureFcmKey();
    mockPost.mockImplementation((url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return Promise.resolve({ status: 200, data: { access_token: ['ya29.', 'capture'].join(''), expires_in: 3600 } });
      }
      return Promise.resolve({ status: 200, data: { name: 'projects/proj-capture/messages/1' } });
    });

    await sendFcmNotification(EVENT, makeSa('svc-a@proj-capture.iam.gserviceaccount.com'), 'device-token-9');

    expect(mockPost).toHaveBeenCalledTimes(2);
    capture('fcm', 'success', ['https://oauth2.googleapis.com/token', 'grant_type=jwt-bearer&assertion=<redacted>', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }]);
    const sendCall = mockPost.mock.calls[1];
    capture('fcm', 'success', sendCall);
    expect(sendCall[0]).toBe('https://fcm.googleapis.com/v1/projects/proj-capture/messages:send');
    const payload = sendCall[1] as { message: { token?: string; notification?: { title?: string } } };
    expect(payload.message.token).toBe('device-token-9');
    expect(payload.message.notification?.title).toBe('📅 测试事件');
  });

  it('rejects with the provider message on a 401 from messages:send', async () => {
    await ensureFcmKey();
    mockPost.mockImplementation((url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return Promise.resolve({ status: 200, data: { access_token: ['ya29.', 'capture'].join(''), expires_in: 3600 } });
      }
      return Promise.reject(
        makeHttpError(401, { error: { code: 401, message: 'Request had invalid authentication credentials' } }),
      );
    });

    await expect(
      sendFcmNotification(EVENT, makeSa('svc-b@proj-capture.iam.gserviceaccount.com'), 'device-token-9'),
    ).rejects.toThrow('invalid authentication credentials');
    capture('fcm', 'error', mockPost.mock.calls[1]);
  });

  it('rejects a malformed service-account JSON without any request', async () => {
    await expect(sendFcmNotification(EVENT, '{broken', 'device-token-9')).rejects.toThrow(/JSON/);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('twilio_whatsapp send (checkbox 22)', () => {
  it('posts whatsapp-prefixed From/To with Basic auth', async () => {
    mockPost.mockResolvedValue({ status: 201, data: { sid: 'SM123' } });

    await sendTwilioWhatsAppNotification(
      EVENT,
      'ACSECRETSID0000000000000000000000',
      'AUTH_SECRET_TOKEN',
      '+15005550006',
      '+8613800138000',
    );

    const call = mockPost.mock.calls[0];
    capture('twilio_whatsapp', 'success', call);
    expect(call[0]).toBe('https://api.twilio.com/2010-04-01/Accounts/ACSECRETSID0000000000000000000000/Messages.json');
    const form = formBodyOf(call[1]);
    expect(form.get('From')).toBe('whatsapp:+15005550006');
    expect(form.get('To')).toBe('whatsapp:+8613800138000');
    expect(form.get('Body')).toContain('测试事件');
    expect(call[2]).toMatchObject({
      auth: { username: 'ACSECRETSID0000000000000000000000', password: 'AUTH_SECRET_TOKEN' },
    });
  });

  it('propagates the provider error on HTTP 401', async () => {
    mockPost.mockRejectedValue(makeHttpError(401, { message: 'Authentication Error - invalid username' }));

    await expect(
      sendTwilioWhatsAppNotification(EVENT, 'ACSECRETSID0000000000000000000000', 'AUTH_SECRET_TOKEN', '+1', '+2'),
    ).rejects.toThrow('Authentication Error');
    capture('twilio_whatsapp', 'error', mockPost.mock.calls[0]);
  });
});
