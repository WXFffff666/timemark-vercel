import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendTelegramNotification(event: any, botToken: string, chatId: string): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const escape = (t: string) => t.replace(/([_*\[\]()~`>#+\-=|.!])/g, '\\$1');
  const text = `📅 *${escape(event.name)}*\n\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${escape(blessing)}`;
  await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'MarkdownV2'
  });
}
