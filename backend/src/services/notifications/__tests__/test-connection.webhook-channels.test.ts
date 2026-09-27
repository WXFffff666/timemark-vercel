import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

interface HttpFixture {
  status: number;
  data?: unknown;
  statusText?: string;
  /** true = axios rejects on a non-2xx HTTP response; false/absent = provider answers 2xx with an error body */
  isHttpError?: boolean;
}

interface WebhookCase {
  name: string;
  type: string;
  webhook: string;
  secret?: string;
  success: HttpFixture;
  failure: HttpFixture;
  failureContains: string;
  checkSuccessRequest: (call: unknown[]) => void;
}

const DINGTALK_URL = 'https://oapi.dingtalk.com/robot/send?access_token=TOKEN123';
const DINGTALK_TS = 1700000000000;
// HMAC-SHA256(`${timestamp}\nSECtest-sign-key`), base64, URL-encoded — computed independently
// with `node -e`, so this pins dingtalk.service.ts's exact algorithm instead of mirroring it.
const DINGTALK_SIGN = 'vIC5W08Cwue2lY%2BGTGRKiJ5goZdUg%2B%2FD%2FJpEwo5EJzM%3D';

const FEISHU_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook-id';
const DISCORD_URL = 'https://discord.com/api/webhooks/123/abc';
const SLACK_URL = 'https://hooks.slack.com/services/T00/B00/XXX';

const cases: WebhookCase[] = [
  {
    name: 'discord',
    type: 'discord',
    webhook: DISCORD_URL,
    // Discord answers 204 No Content on success — never body-check it.
    success: { status: 204, statusText: 'No Content', data: '' },
    failure: { status: 404, statusText: 'Not Found', data: '{"message":"Unknown Webhook"}', isHttpError: true },
    failureContains: '404',
    checkSuccessRequest: ([url, body, config]) => {
      expect(url).toBe(DISCORD_URL);
      expect(body).toMatchObject({ content: expect.any(String), username: expect.any(String) });
      expect(config).toMatchObject({ headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    },
  },
  {
    name: 'slack',
    type: 'slack',
    webhook: SLACK_URL,
    success: { status: 200, data: 'ok' },
    failure: { status: 200, data: 'invalid_payload' },
    failureContains: 'invalid_payload',
    checkSuccessRequest: ([url, body, config]) => {
      expect(url).toBe(SLACK_URL);
      expect(body).toMatchObject({ text: expect.any(String) });
      expect(config).toMatchObject({ headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    },
  },
  {
    name: 'feishu',
    type: 'feishu',
    webhook: FEISHU_URL,
    success: { status: 200, data: { code: 0, msg: 'success' } },
    failure: { status: 200, data: { code: 19021, msg: 'sign match fail' } },
    failureContains: 'sign match fail',
    checkSuccessRequest: ([url, body]) => {
      expect(url).toBe(FEISHU_URL);
      expect(body).toMatchObject({ msg_type: 'text', content: { text: expect.any(String) } });
    },
  },
  {
    name: 'wecom',
    type: 'wecom',
    webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123',
    success: { status: 200, data: { errcode: 0, errmsg: 'ok' } },
    failure: { status: 200, data: { errcode: 93000, errmsg: 'invalid webhook url' } },
    failureContains: 'invalid webhook url',
    checkSuccessRequest: ([url, body]) => {
      expect(url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123');
      expect(body).toMatchObject({ msgtype: 'text', text: { content: expect.any(String) } });
    },
  },
  {
    name: 'dingtalk (with 加签 secret)',
    type: 'dingtalk',
    webhook: DINGTALK_URL,
    secret: 'SECtest-sign-key',
    success: { status: 200, data: { errcode: 0, errmsg: 'ok' } },
    failure: { status: 200, data: { errcode: 310000, errmsg: 'sign not match' } },
    failureContains: 'sign not match',
    checkSuccessRequest: ([url, body, config]) => {
      expect(url).toBe(`${DINGTALK_URL}&timestamp=${DINGTALK_TS}&sign=${DINGTALK_SIGN}`);
      expect(body).toMatchObject({ msgtype: 'text', text: { content: expect.any(String) } });
      expect(config).toMatchObject({ headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    },
  },
  {
    name: 'googlechat',
    type: 'googlechat',
    webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t',
    success: { status: 200, data: { name: 'spaces/AAA/messages/BBB', text: '🔔 TimeMark 测试消息' } },
    failure: { status: 200, data: {} },
    failureContains: '无法识别',
    checkSuccessRequest: ([url, body]) => {
      expect(url).toBe('https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t');
      expect(body).toMatchObject({ text: expect.any(String) });
    },
  },
  {
    name: 'generic_webhook',
    type: 'generic_webhook',
    webhook: 'https://example.com/timemark-hook',
    success: { status: 200, data: { ok: true } },
    failure: { status: 500, statusText: 'Internal Server Error', data: '', isHttpError: true },
    failureContains: '500',
    checkSuccessRequest: ([url, body]) => {
      expect(url).toBe('https://example.com/timemark-hook');
      expect(body).toMatchObject({ text: expect.any(String) });
    },
  },
  {
    name: 'synologychat',
    type: 'synologychat',
    webhook: 'https://nas.example:5001/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=xyz',
    success: { status: 200, data: 'success' },
    failure: { status: 404, statusText: 'Not Found', data: '', isHttpError: true },
    failureContains: '404',
    checkSuccessRequest: ([url, body, config]) => {
      expect(url).toBe(
        'https://nas.example:5001/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=xyz',
      );
      // Synology incoming webhooks take form-urlencoded payload=<json>, never raw JSON.
      expect(String(body)).toContain('payload=');
      expect(config).toMatchObject({
        headers: { 'Content-Type': expect.stringContaining('application/x-www-form-urlencoded') },
        timeout: 10000,
      });
      const payload = JSON.parse(String(new URLSearchParams(String(body)).get('payload')));
      expect(payload).toMatchObject({ text: expect.any(String) });
    },
  },
  {
    name: 'twitch',
    type: 'twitch',
    webhook: 'https://twitch-bridge.example.com/hook',
    success: { status: 200, data: { ok: true } },
    failure: { status: 500, statusText: 'Internal Server Error', data: '', isHttpError: true },
    failureContains: '500',
    checkSuccessRequest: ([url, body]) => {
      expect(url).toBe('https://twitch-bridge.example.com/hook');
      expect(body).toMatchObject({ content: expect.any(String), username: 'TimeMark Bot' });
    },
  },
  {
    name: 'irc',
    type: 'irc',
    webhook: 'https://matterbridge.example.com/api/message',
    success: { status: 200, data: { ok: true } },
    failure: { status: 404, statusText: 'Not Found', data: '', isHttpError: true },
    failureContains: '404',
    checkSuccessRequest: ([url, body]) => {
      expect(url).toBe('https://matterbridge.example.com/api/message');
      expect(body).toMatchObject({ text: expect.any(String), username: 'TimeMark' });
    },
  },
];

describe.each(cases)('$name webhook connection test', (c) => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    if (c.type === 'dingtalk') {
      vi.useFakeTimers();
      vi.setSystemTime(DINGTALK_TS);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('success fixture → success:true with the exact outbound request', async () => {
    mockPost.mockResolvedValue(c.success);

    const result = await testConnection({
      type: c.type,
      configMethod: 'webhook',
      webhook: c.webhook,
      secret: c.secret,
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    c.checkSuccessRequest(mockPost.mock.calls[0]);
    expect(result.success).toBe(true);
  });

  it('error fixture → success:false tracking the provider signal', async () => {
    if (c.failure.isHttpError) {
      mockPost.mockRejectedValue(makeHttpError(c.failure.status, c.failure.statusText ?? '', c.failure.data));
    } else {
      mockPost.mockResolvedValue(c.failure);
    }

    const result = await testConnection({
      type: c.type,
      configMethod: 'webhook',
      webhook: c.webhook,
      secret: c.secret,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain(c.failureContains);
  });
});

describe('B4 regression: HTTP 200 bodies must not be reported as success', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
  });

  it('feishu 200 {"code":19021,"msg":"sign match fail"} → success:false (this used to be success:true)', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      data: { code: 19021, msg: 'sign match fail' },
    });

    const result = await testConnection({ type: 'feishu', configMethod: 'webhook', webhook: FEISHU_URL });

    expect(result.success).toBe(false);
    expect(result.message).toContain('sign match fail');
  });

  it('feishu 200 {"code":0} → success:true', async () => {
    mockPost.mockResolvedValue({ status: 200, statusText: 'OK', data: { code: 0, msg: 'success' } });

    const result = await testConnection({ type: 'feishu', configMethod: 'webhook', webhook: FEISHU_URL });

    expect(result.success).toBe(true);
  });

  it('200 with a malformed body ({}) → clear failure, not success', async () => {
    mockPost.mockResolvedValue({ status: 200, statusText: 'OK', data: {} });

    const result = await testConnection({ type: 'feishu', configMethod: 'webhook', webhook: FEISHU_URL });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/无法识别/);
  });

  it('500 with an empty body → failure naming the status', async () => {
    mockPost.mockRejectedValue(makeHttpError(500, '', ''));

    const result = await testConnection({
      type: 'generic_webhook',
      configMethod: 'webhook',
      webhook: 'https://example.com/timemark-hook',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('500');
  });

  it('discord 204 with no body stays success (no body check)', async () => {
    mockPost.mockResolvedValue({ status: 204, statusText: 'No Content', data: '' });

    const result = await testConnection({ type: 'discord', configMethod: 'webhook', webhook: DISCORD_URL });

    expect(result.success).toBe(true);
  });
});
