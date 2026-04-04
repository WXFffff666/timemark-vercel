import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendWxPusherNotification(event: any, appToken: string, uid: string): Promise<void> {
  const blessing = getBlessing(event.type);
  const content = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  await axios.post('https://wxpusher.zjiecode.com/api/send/message', {
    appToken,
    content,
    summary: `TimeMark提醒：${event.name}`,
    contentType: 1,
    uids: [uid],
  });
}
