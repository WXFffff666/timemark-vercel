import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendPushMeNotification(event: any, pushKey: string): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const title = `📅 ${event.name}`;
  const content = `📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  await axios.post('https://push.i-i.me/', {
    push_key: pushKey,
    title,
    content,
    type: 'text',
  }, { timeout: 15000 });
}
