import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * IRC Webhook 通知服务 (通过桥接服务如 matterbridge 等)
 */
export async function sendIRCNotification(event: any, webhook: string): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  
  const message = `📅 TimeMark 提醒: ${event.name} | 日期: ${event.date} | 类型: ${event.type} | 🎉 ${blessing}`;
  
  // 大多数 IRC 桥接服务接受简单的 JSON 格式
  await axios.post(webhook, {
    text: message,
    username: 'TimeMark'
  }, { timeout: 10000 });
}
