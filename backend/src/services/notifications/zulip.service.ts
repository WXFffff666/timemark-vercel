import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/**
 * Zulip — `POST {org}/api/v1/messages` with HTTP Basic `base64(botEmail:apiKey)` and
 * stream form params `type=stream`, `to` (stream name), `topic`, `content`.
 * The org URL must be a bare origin: a trailing slash is normalized, a path is rejected.
 */
export function normalizeZulipOrgUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) {
    throw new Error('Zulip 组织地址不能为空（形如 https://your-org.zulipchat.com）');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Zulip 组织地址格式无效（形如 https://your-org.zulipchat.com）');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Zulip 组织地址必须使用 https://');
  }
  if (parsed.pathname.replace(/\/+$/, '')) {
    throw new Error('Zulip 组织地址只填域名（如 https://your-org.zulipchat.com），不要包含 /api 等路径');
  }
  return parsed.origin;
}

function buildTitleAndBody(event: Record<string, unknown>): { title: string; body: string } {
  const title = `📅 ${String(event.name ?? '')}`;
  if (event.customMessage) {
    return { title, body: String(event.customMessage) };
  }
  const reminderConfig = event.reminderConfig as { customMessage?: string } | undefined;
  const blessing = getBlessing(
    String(event.type || 'other'),
    reminderConfig?.customMessage,
    event.personName as string | undefined,
    event.reminderRecipientName as string | undefined,
  );
  return {
    title,
    body: `📆 日期: ${String(event.date ?? '')}\n🏷️ 类型: ${String(event.type ?? '')}\n\n🎉 ${blessing}`,
  };
}

export async function sendZulipNotification(
  event: Record<string, unknown>,
  orgUrl: string,
  apiKey: string,
  botEmail: string,
  stream: string,
): Promise<void> {
  const org = normalizeZulipOrgUrl(orgUrl);
  const { title, body } = buildTitleAndBody(event);
  const topic = String(event.name || 'TimeMark').slice(0, 60) || 'TimeMark';
  const authorization = `Basic ${Buffer.from(`${botEmail}:${apiKey}`).toString('base64')}`;
  const response = await axios.post(
    `${org}/api/v1/messages`,
    new URLSearchParams({ type: 'stream', to: stream, topic, content: `${title}\n${body}` }),
    {
      headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    },
  );
  if (response.data?.result !== 'success') {
    throw new Error(`Zulip 发送失败: ${response.data?.msg || '未知错误'}`);
  }
}
