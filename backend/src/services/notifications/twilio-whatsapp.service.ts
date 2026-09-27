import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/**
 * Twilio WhatsApp — same credential model as `twilio` (token = Account SID, secret = Auth Token,
 * webhook = From, chat_id = To). Mirrors the Basic-auth pattern of `twilio.service.ts`; the only
 * difference is the `whatsapp:` channel prefix on From/To.
 */
function buildBody(event: Record<string, unknown>): string {
  const blessing = getBlessing(
    String(event.type || 'other'),
    (event.reminderConfig as { customMessage?: string } | undefined)?.customMessage,
    event.personName as string | undefined,
    event.reminderRecipientName as string | undefined,
  );
  return `${String(event.name ?? '')} · ${String(event.date ?? '')}\n${blessing}`.slice(0, 1500);
}

export async function sendTwilioWhatsAppNotification(
  event: Record<string, unknown>,
  accountSid: string,
  authToken: string,
  fromNumber: string,
  toNumber: string,
): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({
    From: `whatsapp:${fromNumber}`,
    To: `whatsapp:${toNumber}`,
    Body: buildBody(event),
  });
  try {
    await axios.post(url, params, {
      auth: { username: accountSid, password: authToken },
      timeout: 15000,
    });
  } catch (error) {
    const providerMessage = (error as { response?: { data?: { message?: string } } }).response?.data?.message;
    throw new Error(
      providerMessage
        ? `Twilio WhatsApp 发送失败: ${providerMessage}`
        : `Twilio WhatsApp 发送失败: ${(error as Error).message}`,
    );
  }
}
