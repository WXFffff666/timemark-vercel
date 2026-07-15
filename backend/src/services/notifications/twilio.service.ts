import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendTwilioSmsNotification(
  event: Record<string, unknown>,
  accountSid: string,
  authToken: string,
  fromNumber: string,
  toNumber: string,
): Promise<void> {
  const blessing = getBlessing(
    String(event.type || 'other'),
    (event as { reminderConfig?: { customMessage?: string } }).reminderConfig?.customMessage,
    event.personName as string | undefined,
    event.reminderRecipientName as string | undefined,
  );
  const body = `${event.name} · ${event.date}\n${blessing}`.slice(0, 320);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ To: toNumber, From: fromNumber, Body: body });
  await axios.post(url, params, {
    auth: { username: accountSid, password: authToken },
    timeout: 15000,
  });
}
