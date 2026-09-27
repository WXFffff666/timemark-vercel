import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/**
 * Pushback — `POST https://api.pushback.io/v1/send`.
 * Official examples use `Authorization: Bearer <at_token>` with a JSON `{id,title,body}` body.
 * The provider does not publish an explicit response schema: HCLonely/all-pusher-api treats the
 * literal body `0` as success, while other clients only check the HTTP status. Both signals are
 * accepted here so a provider error body never silently reads as success.
 */
export function isPushbackSuccess(data: unknown): boolean {
  if (data === 0 || data === '0') return true;
  if (data && typeof data === 'object') {
    const status = (data as { status?: unknown }).status;
    if (status === 0 || status === 'OK' || status === 'ok' || status === 'success') return true;
  }
  return false;
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

export async function sendPushbackNotification(
  event: Record<string, unknown>,
  token: string,
  userId: string,
): Promise<void> {
  const { title, body } = buildTitleAndBody(event);
  const response = await axios.post(
    'https://api.pushback.io/v1/send',
    { id: userId, title, body },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    },
  );
  if (!isPushbackSuccess(response.data)) {
    const providerMessage = (response.data as { message?: string } | null)?.message;
    throw new Error(
      providerMessage
        ? `Pushback 发送失败: ${providerMessage}`
        : `Pushback 返回了无法识别的响应 (HTTP ${response.status})`,
    );
  }
}
