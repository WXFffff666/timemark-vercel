import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendPushoverNotification(
  event: any,
  userKey: string,
  appToken: string,
  priority?: number,
): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const message = event.customMessage || `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;

  const p = typeof priority === 'number' && priority >= -2 && priority <= 2 ? priority : 0;
  await axios.post('https://api.pushover.net/1/messages.json', {
    token: appToken,
    user: userKey,
    title: `TimeMark: ${event.name}`,
    message,
    priority: p,
  }, { timeout: 10000 });
}
