import { describe, expect, it, vi } from 'vitest';

/**
 * v2.29 batch (wave4)：新渠道的端到端冒烟——mock axios 后逐渠道断言
 * 目标 URL / payload / 认证头形状，防止「模板在目录里但 sender 请求写错」。
 */
process.env.MASTER_KEY ||= 'wave4-test-master-key';
process.env.JWT_SECRET ||= 'wave4-test-jwt-secret';
process.env.DATABASE_URL ||= 'postgres://127.0.0.1:5432/wave4_test';

const axiosPost = vi.hoisted(() => vi.fn().mockResolvedValue({ status: 200, data: { response: 'success' } }));
vi.mock('axios', () => ({
  default: { post: axiosPost, get: vi.fn().mockResolvedValue({ status: 200, data: {} }) },
}));

const {
  sendGuildedNotification,
  sendIftttNotification,
  sendRevoltNotification,
  sendOneSignalNotification,
  sendSendgridNotification,
  sendMailgunNotification,
  sendVonageSmsNotification,
  sendMessagebirdNotification,
  sendAlertzyNotification,
  sendAwtrixNotification,
} = await import('../extended-channels.service.js');

const event = {
  name: '测试事件',
  date: '2026-10-06',
  type: 'other',
  customMessage: '你好，这是提醒内容',
};

describe('wave4 senders', () => {
  it('guilded posts { content } to the raw webhook URL', async () => {
    await sendGuildedNotification(event, 'https://media.guilded.gg/webhooks/a/b');
    expect(axiosPost).toHaveBeenLastCalledWith(
      'https://media.guilded.gg/webhooks/a/b',
      expect.objectContaining({ content: '你好，这是提醒内容' }),
      expect.anything(),
    );
  });

  it('ifttt posts value1..3 to the trigger endpoint with key in path', async () => {
    await sendIftttNotification(event, 'IFTTTKEY', 'timemark_reminder');
    const [url, body] = axiosPost.mock.lastCall!;
    expect(url).toBe('https://maker.ifttt.com/trigger/timemark_reminder/with/key/IFTTTKEY');
    expect(body).toMatchObject({ value1: '测试事件', value3: '你好，这是提醒内容' });
  });

  it('revolt posts { content } with x-bot-token to the channel messages endpoint', async () => {
    await sendRevoltNotification(event, 'BOT TOKEN', '01HCHANNELID');
    const [url, , config] = axiosPost.mock.lastCall!;
    expect(url).toBe('https://api.revolt.chat/channels/01HCHANNELID/messages');
    expect(config.headers['x-bot-token']).toBe('BOT TOKEN');
  });

  it('onesignal targets subscription ids when given, segments otherwise', async () => {
    await sendOneSignalNotification(event, 'OSKEY', 'APPID', 'SUB123');
    expect(axiosPost.mock.lastCall![1]).toMatchObject({
      app_id: 'APPID',
      include_subscription_ids: ['SUB123'],
    });
    await sendOneSignalNotification(event, 'OSKEY', 'APPID', '');
    expect(axiosPost.mock.lastCall![1]).toMatchObject({ included_segments: ['Subscribed Users'] });
  });

  it('sendgrid builds personalizations/from/content', async () => {
    await sendSendgridNotification(event, 'SGKEY', 'noreply@example.com', 'me@example.com');
    const [, body] = axiosPost.mock.lastCall!;
    expect(body).toMatchObject({
      personalizations: [{ to: [{ email: 'me@example.com' }] }],
      from: { email: 'noreply@example.com' },
    });
  });

  it('mailgun posts form data under basic api auth', async () => {
    await sendMailgunNotification(event, 'MGKEY', 'mg.example.com', 'me@example.com');
    const [url, params, config] = axiosPost.mock.lastCall!;
    expect(url).toBe('https://api.mailgun.net/v3/mg.example.com/messages');
    expect(String(params)).toContain('to=me%40example.com');
    expect(config.auth).toEqual({ username: 'api', password: 'MGKEY' });
  });

  it('vonage posts api_key/api_secret/to/from as form data', async () => {
    await sendVonageSmsNotification(event, 'VKEY', 'VSECRET', '8613800138000');
    const [url, params] = axiosPost.mock.lastCall!;
    expect(url).toBe('https://rest.nexmo.com/sms/json');
    expect(String(params)).toContain('api_key=VKEY');
    expect(String(params)).toContain('to=8613800138000');
    expect(String(params)).toContain('from=TimeMark');
  });

  it('messagebird posts recipients/originator/body with AccessKey auth', async () => {
    await sendMessagebirdNotification(event, 'MBKEY', '8613800138000');
    const [, body, config] = axiosPost.mock.lastCall!;
    expect(body).toMatchObject({ recipients: ['8613800138000'], originator: 'TimeMark' });
    expect(config.headers.Authorization).toBe('AccessKey MBKEY');
  });

  it('alertzy posts accountKey/title/body', async () => {
    await sendAlertzyNotification(event, 'AZKEY');
    expect(axiosPost.mock.lastCall![1]).toMatchObject({ accountKey: 'AZKEY', title: '测试事件' });
  });

  it('awtrix posts to {base}/api/notify stripping the trailing slash', async () => {
    await sendAwtrixNotification(event, 'http://192.168.1.50/');
    const [url, body] = axiosPost.mock.lastCall!;
    expect(url).toBe('http://192.168.1.50/api/notify');
    expect(body).toMatchObject({ title: '测试事件', text: '你好，这是提醒内容' });
  });
});
