import axios from 'axios';

export async function sendWeComNotification(event: any, webhookUrl: string): Promise<void> {
  await axios.post(webhookUrl, {
    msgtype: 'markdown',
    markdown: { content: `## 📅 ${event.name}\n\n> **日期:** ${event.date}\n> **类型:** ${event.type}` }
  });
}
