import axios from 'axios';
import crypto from 'crypto';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendDingTalkNotification(event: any, webhookUrl: string, secret: string): Promise<void> {
  const blessing = getBlessing(event.type);
  const timestamp = Date.now();
  const sign = encodeURIComponent(crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'));
  await axios.post(`${webhookUrl}&timestamp=${timestamp}&sign=${sign}`, {
    msgtype: 'markdown',
    markdown: { title: event.name, text: `## 📅 ${event.name}\n\n**日期:** ${event.date}  \n**类型:** ${event.type}\n\n🎉 ${blessing}` }
  });
}
