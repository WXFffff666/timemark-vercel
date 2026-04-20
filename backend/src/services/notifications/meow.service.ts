import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendMeowNotification(event: any, nickname: string): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const title = `📅 ${event.name}`;
  const content = `📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  await axios.post(`https://meopush.com/api/push/${nickname}`, {
    title,
    content,
  }, { timeout: 15000 });
}
