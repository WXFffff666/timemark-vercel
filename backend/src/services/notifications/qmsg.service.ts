import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendQmsgNotification(event: any, key: string, qq?: string): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const msg = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  await axios.post(`https://qmsg.zendee.cn/jsend/${key}`, {
    msg,
    ...(qq ? { qq } : {}),
  });
}
