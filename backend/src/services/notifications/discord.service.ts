import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendDiscordNotification(event: any, webhook: string): Promise<void> {
  const blessing = getBlessing(event.type);
  const content = `📅 **${event.name}**\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  await axios.post(webhook, { content, username: 'TimeMark Bot' });
}
