import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendPushMeNotification(event: any, pushKey: string): Promise<void> {
  let title: string;
  let content: string;
  if (event.customMessage) {
    title = `📅 ${event.name}`;
    content = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    title = `📅 ${event.name}`;
    content = `📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }
  await axios.post('https://push.i-i.me/', {
    push_key: pushKey,
    title,
    content,
    type: 'text',
  }, { timeout: 15000 });
}
