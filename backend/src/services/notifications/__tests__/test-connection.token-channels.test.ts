import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPost, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('axios', () => ({ default: { post: mockPost, get: mockGet } }));

import { testConnection } from '../test-connection.js';

const makeHttpError = (status: number, statusText: string, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, statusText, data },
  });

describe('twilio connection test (bug B3)', () => {
  const SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const AUTH_TOKEN = 'auth-token-abc123';
  const ACCOUNT_URL = `https://api.twilio.com/2010-04-01/Accounts/${SID}.json`;

  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
  });

  it('validates the account with GET + HTTP Basic auth and sends no SMS', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { sid: SID, friendly_name: 'TimeMark', status: 'active' },
    });

    const result = await testConnection({
      type: 'twilio',
      configMethod: 'token',
      token: SID,
      secret: AUTH_TOKEN,
      webhook: '+15005550006',
      chatId: '+8613800138000',
    });

    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, config] = mockGet.mock.calls[0];
    expect(url).toBe(ACCOUNT_URL);
    expect(config).toMatchObject({
      auth: { username: SID, password: AUTH_TOKEN },
      timeout: 10000,
    });
    // A health check must never send a (billable) SMS.
    expect(mockPost).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message).toContain('Twilio');
  });

  it('returns success:false with the provider message on HTTP 401', async () => {
    mockGet.mockRejectedValue(
      makeHttpError(401, 'Unauthorized', {
        code: 20003,
        message: 'Authentication Error - invalid username',
        status: 401,
      }),
    );

    const result = await testConnection({
      type: 'twilio',
      configMethod: 'token',
      token: SID,
      secret: 'wrong-token',
      webhook: '+15005550006',
      chatId: '+8613800138000',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Authentication Error');
  });

  it('returns success:false with a clear message on a 500 with an empty body', async () => {
    mockGet.mockRejectedValue(makeHttpError(500, '', ''));

    const result = await testConnection({
      type: 'twilio',
      configMethod: 'token',
      token: SID,
      secret: AUTH_TOKEN,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('500');
  });
});

describe('wecomapp connection test (bug B3)', () => {
  const CORP_ID = 'wwcorpid123456';
  const CORP_SECRET = 'corp-secret-xyz789';
  const GETTOKEN_URL = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${CORP_SECRET}`;

  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
  });

  it('requests gettoken with corpid/corpsecret and succeeds on errcode 0', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { errcode: 0, errmsg: 'ok', access_token: 'ACCESS_TOKEN', expires_in: 7200 },
    });

    const result = await testConnection({
      type: 'wecomapp',
      configMethod: 'token',
      token: CORP_ID,
      secret: CORP_SECRET,
      chatId: '1000002',
      webhook: '@all',
    });

    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, config] = mockGet.mock.calls[0];
    expect(url).toBe(GETTOKEN_URL);
    expect(config).toMatchObject({ timeout: 10000 });
    expect(result.success).toBe(true);
    expect(result.message).toContain('企微');
  });

  it('fails with the provider errmsg on HTTP 200 + errcode 40013', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { errcode: 40013, errmsg: 'invalid corpid' } });

    const result = await testConnection({
      type: 'wecomapp',
      configMethod: 'token',
      token: CORP_ID,
      secret: 'wrong-secret',
      chatId: '1000002',
      webhook: '@all',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('invalid corpid');
  });
});

describe('apprise connection test (bug B3)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
  });

  it('POSTs {server}/notify with the configured notification URLs', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const result = await testConnection({
      type: 'apprise',
      configMethod: 'token',
      webhook: 'http://apprise.example:8000/',
      token: 'tgram://bottoken/ChatID',
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('http://apprise.example:8000/notify');
    expect(body).toMatchObject({
      urls: 'tgram://bottoken/ChatID',
      title: expect.any(String),
      body: expect.any(String),
      type: 'info',
    });
    expect(config).toMatchObject({
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    expect(result.success).toBe(true);
  });

  it('fails with the provider text when the JSON body says success:false', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: { success: false, error: 'At least one server URL must be specified' },
    });

    const result = await testConnection({
      type: 'apprise',
      configMethod: 'token',
      webhook: 'http://apprise.example:8000',
      token: 'tgram://bottoken/ChatID',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('At least one server URL');
  });

  it('falls back to GET {server}/status when no notification URLs are configured', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { status: 'ok' } });

    const result = await testConnection({
      type: 'apprise',
      configMethod: 'token',
      webhook: 'http://apprise.example:8000',
    });

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(String(mockGet.mock.calls[0][0])).toBe('http://apprise.example:8000/status');
    expect(result.success).toBe(true);
  });

  it('fails with a clear message on a malformed 200 JSON body', async () => {
    mockPost.mockResolvedValue({ status: 200, data: '<html>proxy error</html>' });

    const result = await testConnection({
      type: 'apprise',
      configMethod: 'token',
      webhook: 'http://apprise.example:8000',
      token: 'tgram://bottoken/ChatID',
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/无法识别/);
  });

  it('fails naming the status on a 500 with an empty body', async () => {
    mockPost.mockRejectedValue(makeHttpError(500, '', ''));

    const result = await testConnection({
      type: 'apprise',
      configMethod: 'token',
      webhook: 'http://apprise.example:8000',
      token: 'tgram://bottoken/ChatID',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('500');
  });
});
