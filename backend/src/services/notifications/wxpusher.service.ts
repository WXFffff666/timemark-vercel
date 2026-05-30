import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendWxPusherNotification(event: any, appToken: string, uid: string): Promise<void> {
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
    content = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }
  await axios.post('https://wxpusher.zjiecode.com/api/send/message', {
    appToken,
    content,
    summary: `TimeMark提醒：${event.name}`,
    contentType: 1,
    uids: [uid],
  }, { timeout: 10000 });
}
