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
