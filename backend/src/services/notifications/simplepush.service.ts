import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/**
 * SimplePush.
 * The plan draft named `https://simplepush.io/{key}`, but a live probe on 2026-09-27 returned
 * HTTP 404 for that shape; the working (and SDK-documented) endpoint is
 * `POST https://api.simplepush.io/send` with form fields `key`, `msg`, `title`, answering
 * `{"status":"OK"}`. The 404-probed URL is deliberately NOT used.
 */
export const SIMPLEPUSH_ENDPOINT = 'https://api.simplepush.io/send';

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

export async function sendSimplePushNotification(event: Record<string, unknown>, key: string): Promise<void> {
  const { title, body } = buildTitleAndBody(event);
  const response = await axios.post(
    SIMPLEPUSH_ENDPOINT,
    new URLSearchParams({ key, msg: body, title }),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    },
  );
  // Apprise and all-pusher-api both key success on `status === 'OK'` (live-probed 2026-09-27).
  if (response.data?.status !== 'OK') {
    throw new Error(`SimplePush 发送失败: ${response.data?.message || response.data?.status || '未知错误'}`);
  }
}
