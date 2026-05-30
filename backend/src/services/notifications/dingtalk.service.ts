import axios from 'axios';
import crypto from 'crypto';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendDingTalkNotification(event: any, webhookUrl: string, Secret: string): Promise<void> {
  let markdownText: string;
  if (event.customMessage) {
    markdownText = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    markdownText = `## 📅 ${event.name}\n\n**日期:** ${event.date}  \n**类型:** ${event.type}\n\n🎉 ${blessing}`;
  }
  const timestamp = Date.now();
  const sign = encodeURIComponent(crypto.createHmac('sha256', Secret).update(`${timestamp}\n${Secret}`).digest('base64'));
  await axios.post(`${webhookUrl}&timestamp=${timestamp}&sign=${sign}`, {
    msgtype: 'markdown',
    markdown: { title: event.name, text: markdownText }
  }, { timeout: 10000 });
}
