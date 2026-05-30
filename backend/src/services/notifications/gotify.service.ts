import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendGotifyNotification(
  event: any,
  serverUrl: string,
  token: string,
  priority: number = 5
): Promise<void> {
  let title: string;
  let message: string;
  if (event.customMessage) {
    title = `📅 ${event.name}`;
    message = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    title = `📅 ${event.name}`;
    message = `📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }
  await axios.post(`${serverUrl}/message`, {
    title,
    message,
    priority,
  }, {
    headers: { 'X-Gotify-Key': token },
    timeout: 15000,
  });
}
