import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPost, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn<
    (url: string, data?: unknown, config?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>
  >(),
  mockGet: vi.fn<
    (url: string, config?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>
  >(),
}));

vi.mock('axios', () => ({ default: { post: mockPost, get: mockGet } }));

import crypto from 'node:crypto';
import { testConnection } from '../test-connection.js';

const makeHttpError = (status: number, statusText: string, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, statusText, data },
  });

function formBodyOf(data: unknown): URLSearchParams {
  expect(data).toBeInstanceOf(URLSearchParams);
  return data as URLSearchParams;
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  mockPost.mockReset();
  mockGet.mockReset();
});

describe('serverchan3 (SC3) connection test (checkbox 15)', () => {
  it('derives the uid host from an sctp key and succeeds on code 0', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 0, message: 'ok' } });

    const result = await testConnection({ type: 'serverchan3', configMethod: 'token', token: 'sctp1234tABCDEF' });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('https://1234.push.ft07.com/send/sctp1234tABCDEF.send');
    const form = formBodyOf(body);
    expect(form.get('title')).toContain('TimeMark');
    expect(form.get('desp')).toContain('Server酱');
    expect(config).toMatchObject({ timeout: 10000 });
    expect(result.success).toBe(true);
  });

  it('prefers an explicit UID from the webhook field over the derived one', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 0 } });

    await testConnection({ type: 'serverchan3', configMethod: 'token', token: 'sctp1234tABCDEF', webhook: '9999' });

    const [url] = mockPost.mock.calls[0];
    expect(url).toBe('https://9999.push.ft07.com/send/sctp1234tABCDEF.send');
  });

  it('fails without any request when the key has no derivable uid', async () => {
    const result = await testConnection({ type: 'serverchan3', configMethod: 'token', token: 'SCT_TURBO_ONLY' });

    expect(mockPost).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/UID/);
  });

  it('fails with the provider message on code 40001', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 40001, message: 'invalid sendkey' } });

    const result = await testConnection({ type: 'serverchan3', configMethod: 'token', token: 'sctp1234tBAD' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('invalid sendkey');
  });

  it('surfaces the provider `error` field (live fixture shape) instead of 未知错误', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 10003, error: 'sendkey not found' } });

    const result = await testConnection({ type: 'serverchan3', configMethod: 'token', token: 'sctp1234tBAD' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('sendkey not found');
  });
});

describe('xizhi connection test (checkbox 16)', () => {
  it('posts title/content to {key}.send and accepts code 200', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 200, msg: 'ok' } });

    const result = await testConnection({ type: 'xizhi', configMethod: 'token', token: 'XZ_KEY_1' });

    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('https://xizhi.qqoq.net/XZ_KEY_1.send');
    const form = formBodyOf(body);
    expect(form.get('title')).toContain('TimeMark');
    expect(form.get('content')).toContain('息知');
    expect(config).toMatchObject({ timeout: 10000 });
    expect(result.success).toBe(true);
  });

  it('fails with the provider msg on code 10000 (live-probed error shape)', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 10000, msg: 'key 无效' } });

    const result = await testConnection({ type: 'xizhi', configMethod: 'token', token: 'BAD' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('key 无效');
  });
});

describe('anpush connection test (checkbox 17)', () => {
  it('posts title/content/channel to /push/{token} and accepts code 200', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 200, msg: 'ok' } });

    const result = await testConnection({
      type: 'anpush',
      configMethod: 'token',
      token: 'ANPUSH_TOKEN_1',
      chatId: 'CHANNEL_7',
    });

    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe('https://api.anpush.com/push/ANPUSH_TOKEN_1');
    const form = formBodyOf(body);
    expect(form.get('title')).toContain('TimeMark');
    expect(form.get('content')).toContain('AnPush');
    expect(form.get('channel')).toBe('CHANNEL_7');
    expect(result.success).toBe(true);
  });

  it('fails with the provider message on an invalid token', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { code: 404, msg: 'token invalid' } });

    const result = await testConnection({ type: 'anpush', configMethod: 'token', token: 'BAD' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('token invalid');
  });
});

describe('chanify connection test (checkbox 18)', () => {
  it('normalizes a trailing slash, posts text= and puts the title in the query', async () => {
    mockPost.mockResolvedValue({ status: 200, data: {} });

    const result = await testConnection({
      type: 'chanify',
      configMethod: 'token',
      webhook: 'https://api.chanify.net/',
      token: 'CHANIFY_TOKEN_1',
    });

    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe(
      `https://api.chanify.net/v1/sender/CHANIFY_TOKEN_1?title=${encodeURIComponent('TimeMark 连接测试')}&sound=1`,
    );
    const form = formBodyOf(body);
    expect(form.get('text')).toContain('Chanify');
    expect(config).toMatchObject({
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a base URL that already contains a path instead of building /v1/v1', async () => {
    const result = await testConnection({
      type: 'chanify',
      configMethod: 'token',
      webhook: 'https://api.chanify.net/v1',
      token: 'CHANIFY_TOKEN_1',
    });

    expect(mockPost).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/路径|v1/);
  });

  it('fails naming the token on HTTP 401', async () => {
    mockPost.mockRejectedValue(makeHttpError(401, 'Unauthorized', ''));

    const result = await testConnection({
      type: 'chanify',
      configMethod: 'token',
      webhook: 'https://api.chanify.net',
      token: 'BAD',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Token');
  });
});

describe('pushback connection test (checkbox 19)', () => {
  it('posts Bearer auth + JSON {id,title,body} and accepts a JSON status signal', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { status: 'OK' } });

    const result = await testConnection({
      type: 'pushback',
      configMethod: 'token',
      token: 'at_TEST_TOKEN',
      chatId: 'User_123',
    });

    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('https://api.pushback.io/v1/send');
    expect(body).toMatchObject({ id: 'User_123', title: expect.any(String), body: expect.any(String) });
    const headers = config?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer at_TEST_TOKEN');
    expect(result.success).toBe(true);
  });

  it('also accepts the SDK-documented literal 0 body as success', async () => {
    mockPost.mockResolvedValue({ status: 200, data: 0 });

    const result = await testConnection({
      type: 'pushback',
      configMethod: 'token',
      token: 'at_TEST_TOKEN',
      chatId: 'User_123',
    });

    expect(result.success).toBe(true);
  });

  it('fails naming the access token on HTTP 401', async () => {
    mockPost.mockRejectedValue(makeHttpError(401, 'Unauthorized', ''));

    const result = await testConnection({
      type: 'pushback',
      configMethod: 'token',
      token: 'at_BAD',
      chatId: 'User_123',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Access Token');
  });
});

describe('simplepush connection test (checkbox 19)', () => {
  it('posts key/msg/title and accepts status OK (live-probed endpoint)', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { status: 'OK' } });

    const result = await testConnection({ type: 'simplepush', configMethod: 'token', token: 'SP_KEY_1' });

    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe('https://api.simplepush.io/send');
    const form = formBodyOf(body);
    expect(form.get('key')).toBe('SP_KEY_1');
    expect(form.get('msg')).toContain('SimplePush');
    expect(form.get('title')).toContain('TimeMark');
    expect(result.success).toBe(true);
  });

  it('fails with the provider message when status is not OK', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { status: 'ERROR', message: 'Invalid key' } });

    const result = await testConnection({ type: 'simplepush', configMethod: 'token', token: 'BAD' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid key');
  });
});

describe('zulip connection test (checkbox 20)', () => {
  const ORG = 'https://wave2.zulipchat.com';
  const EMAIL = 'bot@wave2.zulipchat.com';
  const KEY = 'ZULIP_API_KEY_1';

  it('uses base64(email:key) Basic auth and form-encodes type/to/topic/content', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { result: 'success', msg: '' } });

    const result = await testConnection({
      type: 'zulip',
      configMethod: 'token',
      webhook: ORG,
      token: KEY,
      chatId: EMAIL,
      secret: 'time-reminders',
    });

    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe(`${ORG}/api/v1/messages`);
    const headers = config?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${EMAIL}:${KEY}`).toString('base64')}`);
    const form = formBodyOf(body);
    expect(form.get('type')).toBe('stream');
    expect(form.get('to')).toBe('time-reminders');
    expect(form.get('topic')).toBeTruthy();
    expect(form.get('content')).toContain('Zulip');
    expect(result.success).toBe(true);
  });

  it('normalizes a trailing slash on the org URL', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { result: 'success' } });

    await testConnection({
      type: 'zulip',
      configMethod: 'token',
      webhook: `${ORG}/`,
      token: KEY,
      chatId: EMAIL,
      secret: 'time-reminders',
    });

    const [url] = mockPost.mock.calls[0];
    expect(url).toBe(`${ORG}/api/v1/messages`);
  });

  it('rejects an org URL that contains a path with a clear message', async () => {
    const result = await testConnection({
      type: 'zulip',
      configMethod: 'token',
      webhook: `${ORG}/api`,
      token: KEY,
      chatId: EMAIL,
      secret: 'time-reminders',
    });

    expect(mockPost).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/路径|域名/);
  });

  it('fails with the provider msg on result:error', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { result: 'error', msg: 'Invalid API key' } });

    const result = await testConnection({
      type: 'zulip',
      configMethod: 'token',
      webhook: ORG,
      token: 'BAD',
      chatId: EMAIL,
      secret: 'time-reminders',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid API key');
  });
});

describe('rocketchat connection test (checkbox 20)', () => {
  it('posts {"text":...} to the hook URL', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const result = await testConnection({
      type: 'rocketchat',
      configMethod: 'webhook',
      webhook: 'https://chat.example.com/hooks/abc/def',
    });

    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('https://chat.example.com/hooks/abc/def');
    expect(body).toMatchObject({ text: expect.stringContaining('Rocket.Chat') });
    expect(config).toMatchObject({ timeout: 10000 });
    expect(result.success).toBe(true);
  });

  it('fails on HTTP 200 with {"success":false} instead of trusting the status code', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: false, error: 'invalid token' } });

    const result = await testConnection({
      type: 'rocketchat',
      configMethod: 'webhook',
      webhook: 'https://chat.example.com/hooks/abc/def',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('invalid token');
  });
});

describe('fcm connection test (checkbox 21)', () => {
  // RS256 测试密钥用 webcrypto 按需生成一次；PEM 在运行时拼装
  let serviceAccount = {
    project_id: 'proj-wave2',
    client_email: 'svc@proj-wave2.iam.gserviceaccount.com',
    private_key: '',
  };
  let saPublicKey: ReturnType<typeof crypto.createPublicKey> | null = null;
  let fcmKeyPromise: Promise<void> | null = null;
  async function ensureFcmKey(): Promise<void> {
    if (saPublicKey) return;
    if (!fcmKeyPromise) {
      fcmKeyPromise = (async () => {
        const keyPair = await crypto.webcrypto.subtle.generateKey(
          { name: 'RSASSA-PKCS1-v1_5', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
          true,
          ['sign', 'verify'],
        );
        const pkcs8 = await crypto.webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);
        const spki = await crypto.webcrypto.subtle.exportKey('spki', keyPair.publicKey);
        const toPem = (der: ArrayBuffer, label: string): string => {
          const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
          return [`-----BEGIN ${label}-----`, b64, `-----END ${label}-----`, ''].join('\n');
        };
        serviceAccount = { ...serviceAccount, private_key: toPem(pkcs8, 'PRIVATE KEY') };
        saPublicKey = crypto.createPublicKey(toPem(spki, 'PUBLIC KEY'));
      })();
    }
    await fcmKeyPromise;
  }
  const SA_JSON = () => JSON.stringify(serviceAccount);

  // The access-token cache is keyed by client_email, so each case uses a distinct account.
  const saWithEmail = (email: string): string => JSON.stringify({ ...serviceAccount, client_email: email });

  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
  });

  function mockFcmSuccess(): void {
    mockPost.mockImplementation((url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return Promise.resolve({ status: 200, data: { access_token: ['ya29.', 'test-token'].join(''), expires_in: 3600 } });
      }
      return Promise.resolve({ status: 200, data: {} });
    });
  }

  it('signs an RS256 JWT, exchanges it and validate_only-posts to projects/{id}', async () => {
    await ensureFcmKey();
    mockFcmSuccess();

    const result = await testConnection({ type: 'fcm', configMethod: 'token', token: SA_JSON(), chatId: 'device-token-1' });

    expect(result.success).toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenBody, tokenConfig] = mockPost.mock.calls[0];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(tokenConfig).toMatchObject({
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    const form = formBodyOf(tokenBody);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = form.get('assertion');
    expect(jwt).toBeTruthy();
    const [encodedHeader, encodedClaims, signature] = String(jwt).split('.');
    const header = decodeJwtPart(encodedHeader);
    const claims = decodeJwtPart(encodedClaims);
    console.log(
      `[WAVE2-CAPTURE] ${JSON.stringify({ channel: 'fcm', fixture: 'jwt', header, claims })}`,
    );
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(claims.iss).toBe(serviceAccount.client_email);
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(
      crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        saPublicKey!,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);

    const [sendUrl, sendBody, sendConfig] = mockPost.mock.calls[1];
    expect(sendUrl).toBe('https://fcm.googleapis.com/v1/projects/proj-wave2/messages:send');
    const sendHeaders = sendConfig?.headers as Record<string, string>;
    expect(sendHeaders.Authorization).toBe(['Bearer ', 'ya29', '.test-token'].join(''));
    const payload = sendBody as { message: { token?: string; validate_only?: boolean }; validate_only?: boolean };
    expect(payload.message.token).toBe('device-token-1');
    expect(payload.message.validate_only).toBeUndefined();
    expect(payload.validate_only).toBe(true);
  });

  it('routes a topic: target into message.topic', async () => {
    await ensureFcmKey();
    mockFcmSuccess();

    await testConnection({ type: 'fcm', configMethod: 'token', token: saWithEmail('svc-topic@proj-wave2.iam.gserviceaccount.com'), chatId: 'topic:alerts' });

    const [, sendBody] = mockPost.mock.calls[1];
    const payload = sendBody as { message: { topic?: string; token?: string } };
    expect(payload.message.topic).toBe('alerts');
    expect(payload.message.token).toBeUndefined();
  });

  it('fails with a clear message on malformed service-account JSON (no request)', async () => {
    const result = await testConnection({ type: 'fcm', configMethod: 'token', token: '{not-json', chatId: 'device-token-1' });

    expect(mockPost).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/JSON/);
  });

  it('fails with a distinct message on a malformed private key', async () => {
    await ensureFcmKey();
    const broken = JSON.stringify({
      ...serviceAccount,
      client_email: 'svc-broken-key@proj-wave2.iam.gserviceaccount.com',
      private_key: ['-----BEGIN PRIVATE KEY-----', 'broken', '-----END PRIVATE KEY-----'].join('\n'),
    });

    const result = await testConnection({ type: 'fcm', configMethod: 'token', token: broken, chatId: 'device-token-1' });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/私钥|签名|sign/i);
  });

  it('fails with the FCM error message on a 401 from messages:send', async () => {
    await ensureFcmKey();
    const sa401 = saWithEmail('svc-401@proj-wave2.iam.gserviceaccount.com');
    mockPost.mockImplementation((url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return Promise.resolve({ status: 200, data: { access_token: ['ya29.', 'stale'].join(''), expires_in: 3600 } });
      }
      return Promise.reject(
        makeHttpError(401, 'Unauthorized', { error: { code: 401, message: 'Request had invalid authentication credentials' } }),
      );
    });

    const result = await testConnection({ type: 'fcm', configMethod: 'token', token: sa401, chatId: 'device-token-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('invalid authentication credentials');
  });

  it('never writes the service-account JSON or bearer token to the logs', async () => {
    await ensureFcmKey();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const saLogs = saWithEmail('svc-logs@proj-wave2.iam.gserviceaccount.com');
      mockFcmSuccess();
      await testConnection({ type: 'fcm', configMethod: 'token', token: saLogs, chatId: 'device-token-1' });
      mockPost.mockImplementation((url: string) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return Promise.resolve({ status: 200, data: { access_token: ['ya29.', 'secret-token'].join(''), expires_in: 3600 } });
        }
        return Promise.reject(makeHttpError(401, 'Unauthorized', { error: { message: 'nope' } }));
      });
      await testConnection({ type: 'fcm', configMethod: 'token', token: saLogs, chatId: 'device-token-1' });

      const allOutput = JSON.stringify([logSpy.mock.calls, errorSpy.mock.calls, warnSpy.mock.calls]);
      expect(allOutput).not.toContain('PRIVATE KEY');
      expect(allOutput).not.toContain(serviceAccount.private_key.slice(40, 80));
      expect(allOutput).not.toContain('ya29.');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('twilio_whatsapp connection test (checkbox 22)', () => {
  const SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const AUTH_TOKEN = ['auth-token-', 'abc123'].join('');

  it('validates the account with GET + Basic auth and never sends a WhatsApp message', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { sid: SID, friendly_name: 'TimeMark', status: 'active' } });

    const result = await testConnection({
      type: 'twilio_whatsapp',
      configMethod: 'token',
      token: SID,
      secret: AUTH_TOKEN,
      webhook: '+15005550006',
      chatId: '+8613800138000',
    });

    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, config] = mockGet.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`);
    expect(config).toMatchObject({ auth: { username: SID, password: AUTH_TOKEN }, timeout: 10000 });
    expect(mockPost).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message).toContain('WhatsApp');
  });

  it('fails with the provider message on HTTP 401', async () => {
    mockGet.mockRejectedValue(
      makeHttpError(401, 'Unauthorized', { code: 20003, message: 'Authentication Error - invalid username', status: 401 }),
    );

    const result = await testConnection({
      type: 'twilio_whatsapp',
      configMethod: 'token',
      token: SID,
      secret: 'wrong-token',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Authentication Error');
  });
});
