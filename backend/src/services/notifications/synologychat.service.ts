import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * Synology Chat Webhook 通知服务
 * https://www.synology.com/zh-cn/dsm/feature/chat
 */
export async function sendSynologyChatNotification(event: any, webhook: string): Promise<void> {
  let message: string;
  if (event.customMessage) {
    message = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    message = `📅 *${event.name}*\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }
  
  // Synology Chat 使用 payload 格式
  const payload = JSON.stringify({
    text: message
  });

  await axios.post(webhook, payload, {
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
}
