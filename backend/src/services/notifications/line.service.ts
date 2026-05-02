import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * LINE Messaging API 通知服务
 * https://developers.line.biz/en/docs/messaging-api/overview/
 */
export async function sendLINENotification(event: any, token: string, userId: string): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  
  const message = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  
  await axios.post('https://api.line.me/v2/bot/message/push', {
    to: userId,
    messages: [
      {
        type: 'text',
        text: message
      }
    ]
  }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
}
