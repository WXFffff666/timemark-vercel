import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * Twitch EventSub/Webhook 通知服务
 * https://dev.twitch.tv/docs/eventsub
 */
export async function sendTwitchNotification(event: any, webhook: string): Promise<void> {
  const blessing = getBlessing(event.type);
  
  // Twitch 风格的简洁消息
  const message = `📅 TimeMark 提醒: ${event.name} | 📆 ${event.date} | 🎉 ${blessing}`;
  
  await axios.post(webhook, {
    content: message,
    username: 'TimeMark Bot'
  });
}
