import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendDiscordNotification(event: any, webhook: string): Promise<void> {
  // 智能匹配祝福语：根据被提醒人和提醒人自动适配
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const content = `📅 **${event.name}**\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  await axios.post(webhook, { content, username: 'TimeMark Bot' });
}
