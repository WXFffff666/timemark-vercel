import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendFeishuNotification(event: any, webhookUrl: string): Promise<void> {
  let cardContent: string;
  if (event.customMessage) {
    cardContent = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    cardContent = `**日期:** ${event.date}\n**类型:** ${event.type}\n\n🎉 ${blessing}`;
  }
  await axios.post(webhookUrl, {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: `📅 ${event.name}` }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: cardContent } }
      ]
    }
  }, { timeout: 10000 });
}
