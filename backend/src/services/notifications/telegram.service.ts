import axios from 'axios';

export async function sendTelegramNotification(event: any, botToken: string, chatId: string): Promise<void> {
  const escape = (t: string) => t.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  const text = `📅 *${escape(event.name)}*\n\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}`;
  await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'MarkdownV2'
  });
}
