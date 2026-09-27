import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

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
  
  // Synology Chat 传入 Webhook 要求 form-urlencoded 的 `payload=<json>` 字段
  // （Content-Type: application/x-www-form-urlencoded），不是裸 JSON。
  const payload = JSON.stringify({
    text: message
  });

  await axios.post(webhook, new URLSearchParams({ payload }), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 10000
  });
}
