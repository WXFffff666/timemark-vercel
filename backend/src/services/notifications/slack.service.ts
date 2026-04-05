import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendSlackNotification(event: any, webhook: string): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  await axios.post(webhook, {
    text: `📅 ${event.name}（${event.type}）`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*📅 ${event.name}*\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}` } }],
  });
}
