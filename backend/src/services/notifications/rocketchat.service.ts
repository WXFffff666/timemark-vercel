import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/**
 * Rocket.Chat incoming webhook — `POST https://{server}/hooks/{integrationId}/{token}` with `{text}`.
 * A 2xx is required, and a JSON body carrying `success:false` is treated as a failure
 * (never trust a bare 2xx when the provider answers with an error flag).
 */
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

export async function sendRocketChatNotification(event: Record<string, unknown>, webhookUrl: string): Promise<void> {
  const { title, body } = buildTitleAndBody(event);
  const response = await axios.post(
    webhookUrl,
    { text: `${title}\n${body}` },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Rocket.Chat 返回状态码: ${response.status}`);
  }
  const data = response.data as { success?: boolean; error?: string; message?: string } | null | undefined;
  if (data && typeof data === 'object' && data.success === false) {
    throw new Error(`Rocket.Chat 发送失败: ${data.error || data.message || JSON.stringify(data).slice(0, 200)}`);
  }
}
