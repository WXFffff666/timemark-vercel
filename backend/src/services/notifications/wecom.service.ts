import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendWeComNotification(event: any, webhookUrl: string): Promise<void> {
  let content: string;
  if (event.customMessage) {
    content = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    content = `## 📅 ${event.name}\n\n> **日期:** ${event.date}\n> **类型:** ${event.type}\n\n🎉 ${blessing}`;
  }
  await axios.post(webhookUrl, {
    msgtype: 'markdown',
    markdown: { content }
  }, { timeout: 10000 });
}
