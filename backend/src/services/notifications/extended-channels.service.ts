import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/**
 * v78 新增渠道（batch 3）：WhatsApp Cloud API（Meta 官方）、Kook、Fanbook、Home Assistant。
 * 与既有渠道一致的约定：send* 抛错 = 失败（由调用方重试/熔断）；test* 永不抛错。
 */

interface ChannelMessageInput {
  name?: string;
  date?: string;
  type?: string;
  customMessage?: string;
  reminderConfig?: { customMessage?: string };
  personName?: string;
  reminderRecipientName?: string;
  reminder_recipient_name?: string;
}

function buildMessage(event: ChannelMessageInput): string {
  const blessing = getBlessing(
    event.type ?? 'other',
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName ?? event.reminder_recipient_name ?? '',
  );
  return event.customMessage || `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
}

// ============ WhatsApp Cloud API（Meta 官方，区别于 twilio_whatsapp） ============
// account.token = 永久访问令牌，account.secret = Phone Number ID，account.chat_id = 收件人手机号

export async function sendWhatsAppCloudNotification(event: any, token: string, phoneNumberId: string, to: string): Promise<void> {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(to).replace(/[^\d+]/g, ''),
      type: 'text',
      text: { preview_url: false, body: buildMessage(event) },
    },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    },
  );
}

// ============ Kook 机器人 Webhook ============

export async function sendKookNotification(event: any, webhook: string): Promise<void> {
  await axios.post(
    webhook,
    { content: buildMessage(event) },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

// ============ Fanbook 机器人 Webhook ============

export async function sendFanbookNotification(event: any, webhook: string): Promise<void> {
  await axios.post(
    webhook,
    { content: buildMessage(event) },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

// ============ Home Assistant 通知服务 ============
// account.webhook = HA 地址（http://homeassistant.local:8123），account.token = 长期访问令牌，
// account.chat_id = notify 服务名（如 mobile_app_iphone）

export async function sendHomeAssistantNotification(event: any, baseUrl: string, token: string, service: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/services/notify/${service}`;
  const message = buildMessage(event);
  await axios.post(
    url,
    { title: `TimeMark: ${event.name}`, message },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    },
  );
}

export type TestConnectionResult = { success: boolean; message: string; details?: string };

export async function testWhatsAppCloudChannel(token: string, phoneNumberId: string, to: string): Promise<TestConnectionResult> {
  if (!token || !phoneNumberId || !to) {
    return { success: false, message: '访问令牌、Phone Number ID 和收件人手机号都不能为空' };
  }
  try {
    await axios.get(`https://graph.facebook.com/v21.0/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return { success: true, message: 'WhatsApp Cloud API 凭据有效（Phone Number ID 可访问）' };
  } catch (error: any) {
    const status = error?.response?.status;
    const message = error?.response?.data?.error?.message || error?.message || '连接失败';
    return { success: false, message: status ? `WhatsApp Cloud API 错误（HTTP ${status}）：${message}` : `连接失败：${message}` };
  }
}

export async function testKookChannel(webhook: string): Promise<TestConnectionResult> {
  if (!webhook) return { success: false, message: 'Webhook 地址不能为空' };
  try {
    const res = await axios.post(webhook, { content: 'TimeMark 渠道测试：如果你看到这条消息，说明 Kook 渠道已通。' }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    const code = res?.data?.code;
    if (code === 0 || code === undefined || code === null) {
      return { success: true, message: '测试消息已发送（请在 Kook 频道确认）' };
    }
    return { success: false, message: `Kook 返回错误码 ${code}：${res?.data?.message ?? 'unknown'}` };
  } catch (error: any) {
    return { success: false, message: `连接失败：${error?.message || 'unknown'}` };
  }
}

export async function testFanbookChannel(webhook: string): Promise<TestConnectionResult> {
  if (!webhook) return { success: false, message: 'Webhook 地址不能为空' };
  try {
    await axios.post(webhook, { content: 'TimeMark 渠道测试：如果你看到这条消息，说明 Fanbook 渠道已通。' }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return { success: true, message: '测试消息已发送（请在 Fanbook 频道确认）' };
  } catch (error: any) {
    return { success: false, message: `连接失败：${error?.message || 'unknown'}` };
  }
}

export async function testHomeAssistantChannel(baseUrl: string, token: string, service: string): Promise<TestConnectionResult> {
  if (!baseUrl || !token || !service) {
    return { success: false, message: 'HA 地址、长期访问令牌和通知服务名都不能为空' };
  }
  try {
    await axios.get(`${baseUrl.replace(/\/$/, '')}/api/`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return { success: true, message: `HA 连接成功（服务 notify/${service} 将用于发送）` };
  } catch (error: any) {
    const status = error?.response?.status;
    const message = error?.message || 'unknown';
    return { success: false, message: status ? `HA 错误（HTTP ${status}）：${message}` : `连接失败：${message}` };
  }
}

// ============ v2.28 batch：PushBullet / Join / PushSafer / Webex / Notifiarr ============
// 与 batch 3 同一约定：send* 抛错 = 失败；test* 永不抛错。全部纯 axios 单 POST。

// ---- PushBullet：account.token = Access-Token ----

export async function sendPushBulletNotification(event: any, token: string): Promise<void> {
  await axios.post(
    'https://api.pushbullet.com/v2/pushes',
    { type: 'note', title: event.name ?? 'TimeMark 提醒', body: buildMessage(event) },
    { headers: { 'Access-Token': token, 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

export async function testPushBulletChannel(token: string): Promise<TestConnectionResult> {
  if (!token) return { success: false, message: 'Access-Token 不能为空' };
  try {
    await axios.post(
      'https://api.pushbullet.com/v2/pushes',
      { type: 'note', title: 'TimeMark 渠道测试', body: '如果你看到这条消息，说明 PushBullet 渠道已通。' },
      { headers: { 'Access-Token': token, 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    return { success: true, message: '测试消息已发送（请在 PushBullet 客户端确认）' };
  } catch (error: any) {
    const status = error?.response?.status;
    return { success: false, message: status ? `PushBullet 错误（HTTP ${status}）：${error?.message || 'unknown'}` : `连接失败：${error?.message || 'unknown'}` };
  }
}

// ---- Join (joaoapps)：account.token = Api Key，account.chat_id = Device ID（可选，留空发全部设备）----

export async function sendJoinNotification(event: any, apiKey: string, deviceId: string): Promise<void> {
  await axios.post(
    'https://joinjoaomgcd.appspot.com/_ah/api/messaging/v1/sendPush',
    { title: event.name ?? 'TimeMark 提醒', text: buildMessage(event) },
    {
      params: deviceId ? { apikey: apiKey, deviceId } : { apikey: apiKey, deviceId: 'group.all' },
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    },
  );
}

export async function testJoinChannel(apiKey: string, deviceId: string): Promise<TestConnectionResult> {
  if (!apiKey) return { success: false, message: 'Api Key 不能为空' };
  try {
    await axios.post(
      'https://joinjoaomgcd.appspot.com/_ah/api/messaging/v1/sendPush',
      { title: 'TimeMark 渠道测试', text: '如果你看到这条消息，说明 Join 渠道已通。' },
      {
        params: deviceId ? { apikey: apiKey, deviceId } : { apikey: apiKey, deviceId: 'group.all' },
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      },
    );
    return { success: true, message: '测试消息已发送（请在 Join 客户端确认）' };
  } catch (error: any) {
    const status = error?.response?.status;
    return { success: false, message: status ? `Join 错误（HTTP ${status}）：${error?.message || 'unknown'}` : `连接失败：${error?.message || 'unknown'}` };
  }
}

// ---- PushSafer：account.token = Private Key ----

export async function sendPushSaferNotification(event: any, privateKey: string): Promise<void> {
  await axios.post(
    'https://www.pushsafer.com/api',
    { k: privateKey, t: event.name ?? 'TimeMark 提醒', m: buildMessage(event) },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

export async function testPushSaferChannel(privateKey: string): Promise<TestConnectionResult> {
  if (!privateKey) return { success: false, message: 'Private Key 不能为空' };
  try {
    await axios.post(
      'https://www.pushsafer.com/api',
      { k: privateKey, t: 'TimeMark 渠道测试', m: '如果你看到这条消息，说明 PushSafer 渠道已通。' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    return { success: true, message: '测试消息已发送（请在 PushSafer 客户端确认）' };
  } catch (error: any) {
    const status = error?.response?.status;
    return { success: false, message: status ? `PushSafer 错误（HTTP ${status}）：${error?.message || 'unknown'}` : `连接失败：${error?.message || 'unknown'}` };
  }
}

// ---- Webex：account.webhook = Incoming Webhook 完整 URL（Discord 同构）----

export async function sendWebexNotification(event: any, webhook: string): Promise<void> {
  await axios.post(
    webhook,
    { markdown: buildMessage(event) },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

// ---- Notifiarr：account.webhook = Passthrough 通道完整 URL ----

export async function sendNotifiarrNotification(event: any, webhook: string): Promise<void> {
  await axios.post(
    webhook,
    { payload: { title: event.name ?? 'TimeMark 提醒', message: buildMessage(event) } },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

// ============ v2.29 batch（wave4）：Guilded / IFTTT / Revolt / OneSignal / SendGrid /
// Mailgun / Vonage SMS / MessageBird / Alertzy / Awtrix。同一约定：send* 抛错 = 失败；
// test* 永不抛错。全部纯 axios 单次请求，零新依赖。 ============

// ---- Guilded：account.webhook = Incoming Webhook 完整 URL（Discord 同构）----

export async function sendGuildedNotification(event: any, webhook: string): Promise<void> {
  await axios.post(
    webhook,
    { content: buildMessage(event) },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

// ---- IFTTT Webhooks：account.token = Webhooks Key，account.webhook = 触发事件名 ----

export async function sendIftttNotification(event: any, key: string, eventName: string): Promise<void> {
  await axios.post(
    `https://maker.ifttt.com/trigger/${encodeURIComponent(eventName)}/with/key/${encodeURIComponent(key)}`,
    { value1: event.name ?? 'TimeMark 提醒', value2: event.date ?? '', value3: buildMessage(event) },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

export async function testIftttChannel(key: string, eventName: string): Promise<TestConnectionResult> {
  if (!key || !eventName) return { success: false, message: 'Webhooks Key 和触发事件名都不能为空' };
  try {
    await axios.post(
      `https://maker.ifttt.com/trigger/${encodeURIComponent(eventName)}/with/key/${encodeURIComponent(key)}`,
      { value1: 'TimeMark 渠道测试', value2: '', value3: '如果你看到这条消息，说明 IFTTT 渠道已通。' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    return { success: true, message: '测试请求已发送（请在 IFTTT Applet 确认触发）' };
  } catch (error: any) {
    const status = error?.response?.status;
    return { success: false, message: status ? `IFTTT 错误（HTTP ${status}）：${error?.message || 'unknown'}` : `连接失败：${error?.message || 'unknown'}` };
  }
}

// ---- Revolt：account.token = Bot Token，account.chat_id = 频道 ID ----

export async function sendRevoltNotification(event: any, botToken: string, channelId: string): Promise<void> {
  await axios.post(
    `https://api.revolt.chat/channels/${encodeURIComponent(channelId)}/messages`,
    { content: buildMessage(event) },
    { headers: { 'x-bot-token': botToken, 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

export async function testRevoltChannel(botToken: string, channelId: string): Promise<TestConnectionResult> {
  if (!botToken || !channelId) return { success: false, message: 'Bot Token 和频道 ID 都不能为空' };
  try {
    await axios.post(
      `https://api.revolt.chat/channels/${encodeURIComponent(channelId)}/messages`,
      { content: 'TimeMark 渠道测试：如果你看到这条消息，说明 Revolt 渠道已通。' },
      { headers: { 'x-bot-token': botToken, 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    return { success: true, message: '测试消息已发送（请在 Revolt 频道确认）' };
  } catch (error: any) {
    const status = error?.response?.status;
    return { success: false, message: status ? `Revolt 错误（HTTP ${status}）：${error?.message || 'unknown'}` : `连接失败：${error?.message || 'unknown'}` };
  }
}

// ---- OneSignal：account.token = REST API Key，account.secret = App ID，
//      account.chat_id = Subscription ID（可选，留空发给 Subscribed Users 分段）----

export async function sendOneSignalNotification(event: any, apiKey: string, appId: string, subscriptionId: string): Promise<void> {
  const body: Record<string, unknown> = {
    app_id: appId,
    headings: { en: event.name ?? 'TimeMark 提醒' },
    contents: { en: buildMessage(event) },
  };
  if (subscriptionId) body.include_subscription_ids = [subscriptionId];
  else body.included_segments = ['Subscribed Users'];
  await axios.post('https://api.onesignal.com/notifications', body, {
    headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

export async function testOneSignalChannel(apiKey: string, appId: string): Promise<TestConnectionResult> {
  if (!apiKey || !appId) return { success: false, message: 'REST API Key 和 App ID 都不能为空' };
  try {
    await axios.get(`https://api.onesignal.com/apps/${appId}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` },
      timeout: 10000,
    });
    return { success: true, message: 'OneSignal 凭据有效（App 可访问）' };
  } catch (error: any) {
    const status = error?.response?.status;
    const message = error?.response?.data?.errors?.join?.('; ') || error?.message || '连接失败';
    return { success: false, message: status ? `OneSignal 错误（HTTP ${status}）：${message}` : `连接失败：${message}` };
  }
}

// ---- SendGrid：account.token = API Key，account.secret = 发件人邮箱，account.chat_id = 收件人邮箱 ----

export async function sendSendgridNotification(event: any, apiKey: string, from: string, to: string): Promise<void> {
  await axios.post(
    'https://api.sendgrid.com/v3/mail/send',
    {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject: event.name ?? 'TimeMark 提醒',
      content: [{ type: 'text/plain', value: buildMessage(event) }],
    },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

export async function testSendgridChannel(apiKey: string, from: string, to: string): Promise<TestConnectionResult> {
  if (!apiKey || !from || !to) return { success: false, message: 'API Key、发件人邮箱和收件人邮箱都不能为空' };
  try {
    await axios.post(
      'https://api.sendgrid.com/v3/mail/send',
      {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject: 'TimeMark 渠道测试',
        content: [{ type: 'text/plain', value: '如果你看到这封邮件，说明 SendGrid 渠道已通。' }],
        mail_settings: { sandbox_mode: { enable: true } },
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    return { success: true, message: 'SendGrid 凭据有效（沙箱模式验证通过，未真实发信）' };
  } catch (error: any) {
    const status = error?.response?.status;
    const message = error?.response?.data?.errors?.[0]?.message || error?.message || '连接失败';
    return { success: false, message: status ? `SendGrid 错误（HTTP ${status}）：${message}` : `连接失败：${message}` };
  }
}

// ---- Mailgun：account.token = API Key，account.webhook = 发信域名，account.chat_id = 收件人邮箱 ----

export async function sendMailgunNotification(event: any, apiKey: string, domain: string, to: string): Promise<void> {
  const params = new URLSearchParams({
    from: `TimeMark <postmaster@${domain}>`,
    to,
    subject: event.name ?? 'TimeMark 提醒',
    text: buildMessage(event),
  });
  await axios.post(`https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, params, {
    auth: { username: 'api', password: apiKey },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
}

export async function testMailgunChannel(apiKey: string, domain: string, to: string): Promise<TestConnectionResult> {
  if (!apiKey || !domain || !to) return { success: false, message: 'API Key、发信域名和收件人邮箱都不能为空' };
  try {
    const params = new URLSearchParams({ from: `TimeMark <postmaster@${domain}>`, to, subject: 'TimeMark 渠道测试', text: '如果你看到这封邮件，说明 Mailgun 渠道已通。' });
    await axios.post(`https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, params, {
      auth: { username: 'api', password: apiKey },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    return { success: true, message: '测试邮件已发送（请查收邮箱确认）' };
  } catch (error: any) {
    const status = error?.response?.status;
    return { success: false, message: status ? `Mailgun 错误（HTTP ${status}）：${error?.message || 'unknown'}` : `连接失败：${error?.message || 'unknown'}` };
  }
}

// ---- Vonage SMS：account.token = API Key，account.secret = API Secret，account.chat_id = 收件人手机号 ----

export async function sendVonageSmsNotification(event: any, apiKey: string, apiSecret: string, to: string): Promise<void> {
  const params = new URLSearchParams({ api_key: apiKey, api_secret: apiSecret, to: String(to).replace(/[^\d+]/g, ''), from: 'TimeMark', text: buildMessage(event) });
  await axios.post('https://rest.nexmo.com/sms/json', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
}

export async function testVonageSmsChannel(apiKey: string, apiSecret: string, to: string): Promise<TestConnectionResult> {
  if (!apiKey || !apiSecret || !to) return { success: false, message: 'API Key、API Secret 和收件人手机号都不能为空' };
  try {
    const params = new URLSearchParams({ api_key: apiKey, api_secret: apiSecret });
    await axios.post('https://rest.nexmo.com/account/get-balance', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    return { success: true, message: 'Vonage 凭据有效（账户余额可查询，未消耗短信条数）' };
  } catch (error: any) {
    const status = error?.response?.status;
    return { success: false, message: status ? `Vonage 错误（HTTP ${status}）：${error?.message || 'unknown'}` : `连接失败：${error?.message || 'unknown'}` };
  }
}

// ---- MessageBird SMS：account.token = Access Key，account.chat_id = 收件人手机号 ----

export async function sendMessagebirdNotification(event: any, accessKey: string, to: string): Promise<void> {
  await axios.post(
    'https://rest.messagebird.com/messages',
    { recipients: [String(to).replace(/[^\d+]/g, '')], originator: 'TimeMark', body: buildMessage(event) },
    { headers: { Authorization: `AccessKey ${accessKey}`, 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

export async function testMessagebirdChannel(accessKey: string, to: string): Promise<TestConnectionResult> {
  if (!accessKey || !to) return { success: false, message: 'Access Key 和收件人手机号都不能为空' };
  try {
    await axios.get('https://rest.messagebird.com/balance', {
      headers: { Authorization: `AccessKey ${accessKey}` },
      timeout: 10000,
    });
    return { success: true, message: 'MessageBird 凭据有效（账户余额可查询，未消耗短信条数）' };
  } catch (error: any) {
    const status = error?.response?.status;
    return { success: false, message: status ? `MessageBird 错误（HTTP ${status}）：${error?.message || 'unknown'}` : `连接失败：${error?.message || 'unknown'}` };
  }
}

// ---- Alertzy：account.token = Account Key ----

export async function sendAlertzyNotification(event: any, accountKey: string): Promise<void> {
  await axios.post(
    'https://alertzy.app/send',
    { accountKey, title: event.name ?? 'TimeMark 提醒', body: buildMessage(event) },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

export async function testAlertzyChannel(accountKey: string): Promise<TestConnectionResult> {
  if (!accountKey) return { success: false, message: 'Account Key 不能为空' };
  try {
    const res = await axios.post(
      'https://alertzy.app/send',
      { accountKey, title: 'TimeMark 渠道测试', body: '如果你看到这条消息，说明 Alertzy 渠道已通。' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    // Alertzy 成功返回 response: 'success'（HTTP 200 也可能带错误信息）
    if (res?.data?.response === 'success') {
      return { success: true, message: '测试消息已发送（请在 Alertzy 客户端确认）' };
    }
    return { success: false, message: `Alertzy 返回错误：${res?.data?.error ?? JSON.stringify(res?.data ?? {})}` };
  } catch (error: any) {
    const status = error?.response?.status;
    return { success: false, message: status ? `Alertzy 错误（HTTP ${status}）：${error?.message || 'unknown'}` : `连接失败：${error?.message || 'unknown'}` };
  }
}

// ---- Awtrix 3 像素时钟：account.webhook = 设备地址（如 http://192.168.1.50）----

export async function sendAwtrixNotification(event: any, baseUrl: string): Promise<void> {
  await axios.post(
    `${baseUrl.replace(/\/$/, '')}/api/notify`,
    { title: event.name ?? 'TimeMark 提醒', text: buildMessage(event) },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
}

