import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

const DEFAULT_PUSHDEER_API = 'https://api2.pushdeer.com';

export async function sendPushDeerNotification(
  event: any,
  pushKey: string,
  serverUrl = DEFAULT_PUSHDEER_API,
): Promise<void> {
  let text: string;
  if (event.customMessage) {
    text = `📅 ${event.name}\n\n${event.customMessage}`;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName,
    );
    text = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }

  const base = serverUrl.replace(/\/$/, '');
  const response = await axios.post(
    `${base}/message/push`,
    new URLSearchParams({ pushkey: pushKey, text, type: 'text' }),
    { timeout: 15000 },
  );

  if (response.data?.code !== 0 && response.data?.error) {
    throw new Error(`PushDeer push failed: ${response.data.error}`);
  }
}
