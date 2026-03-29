import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendWeComNotification(event: any, webhookUrl: string): Promise<void> {
  const blessing = getBlessing(event.type);
  await axios.post(webhookUrl, {
    msgtype: 'markdown',
    markdown: { content: `## 📅 ${event.name}\n\n> **日期:** ${event.date}\n> **类型:** ${event.type}\n\n🎉 ${blessing}` }
  });
}
