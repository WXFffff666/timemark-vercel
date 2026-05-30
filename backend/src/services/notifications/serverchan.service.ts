import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendServerChanNotification(event: any, sendKey: string): Promise<void> {
  let title: string;
  let desp: string;
  if (event.customMessage) {
    title = `📅 ${event.name}`;
    desp = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    title = `📅 ${event.name}`;
    desp = `📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }
  await axios.post(`https://sctapi.ftqq.com/${sendKey}.send`, {
    title,
    desp,
  }, { timeout: 15000 });
}
