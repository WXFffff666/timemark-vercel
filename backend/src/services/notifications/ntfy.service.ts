import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

export async function sendNtfyNotification(
  event: any,
  serverUrl: string,
  topic: string
): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const message = event.customMessage || `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;

  // JSON publish（POST 到服务器根路径）而不是 `/{topic}` + HTTP 头：
  // Title 里的中文（事件名）放进 HTTP 头会被 ntfy 以 400 拒绝（非 ASCII 头不合法），
  // JSON 体没有这个限制，自托管与官方 ntfy.sh 行为一致。
  const url = `${serverUrl.replace(/\/$/, '')}/`;
  await axios.post(
    url,
    {
      topic,
      title: `TimeMark: ${event.name}`,
      message,
      priority: 3,
      tags: ['calendar'],
    },
    { timeout: 10000 },
  );
}
