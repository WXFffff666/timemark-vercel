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
  // ServerChan3 新版 key (sctp开头) 使用 ft07.com 域名
  const matchResult = sendKey.match(/^sctp(\d+)t/i);
  const url = matchResult && matchResult[1]
    ? `https://${matchResult[1]}.push.ft07.com/send/${sendKey}.send`
    : `https://sctapi.ftqq.com/${sendKey}.send`;

  await axios.post(url, {
    title,
    desp,
  }, { timeout: 15000 });
}
