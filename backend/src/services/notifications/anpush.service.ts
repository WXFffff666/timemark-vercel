import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/** AnPush — `POST https://api.anpush.com/push/{token}` (form: title/content, optional channel). */
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

export function buildAnPushUrl(token: string): string {
  return `https://api.anpush.com/push/${encodeURIComponent(token)}`;
}

export async function sendAnPushNotification(
  event: Record<string, unknown>,
  token: string,
  channel?: string,
): Promise<void> {
  const { title, body } = buildTitleAndBody(event);
  const params = new URLSearchParams({ title, content: body });
  if (channel) params.set('channel', channel);
  const response = await axios.post(buildAnPushUrl(token), params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  // certd's AnPush plugin and the documented examples agree on `code === 200` for success.
  if (response.data?.code !== 200) {
    throw new Error(`AnPush 发送失败: ${response.data?.msg || response.data?.message || '未知错误'}`);
  }
}
