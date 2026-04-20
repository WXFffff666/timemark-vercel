import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendClawBotNotification(
  event: any,
  token: string,
  toUserId: string,
  baseUrl: string = 'https://ilinkai.weixin.qq.com'
): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const text = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  await axios.post(`${baseUrl}/ilink/bot/sendmessage`, {
    toUserId,
    text,
    contextToken: token,
  }, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
}
