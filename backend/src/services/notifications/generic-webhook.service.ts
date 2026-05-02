import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendGenericWebhookNotification(event: any, webhook: string, channelLabel: string): Promise<void> {
  const blessing = getBlessing(event.type);
  const text = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;

  await axios.post(webhook, {
    text,
    channel: channelLabel,
    title: `TimeMark提醒：${event.name}`,
    event,
  }, { timeout: 10000 });
}
