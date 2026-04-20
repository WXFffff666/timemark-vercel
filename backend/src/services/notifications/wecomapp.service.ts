import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendWeComAppNotification(
  event: any,
  corpid: string,
  corpsecret: string,
  agentid: string,
  touser: string
): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const content = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;

  // Step 1: Get access_token
  const tokenRes = await axios.get(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpid}&corpsecret=${corpsecret}`,
    { timeout: 15000 }
  );
  if (tokenRes.data.errcode !== 0) {
    throw new Error(`WeComApp get token failed: ${tokenRes.data.errmsg}`);
  }
  const accessToken = tokenRes.data.access_token;

  // Step 2: Send message
  const response = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
    {
      touser,
      msgtype: 'text',
      agentid: Number(agentid),
      text: { content },
    },
    { timeout: 15000 }
  );
  if (response.data.errcode !== 0) {
    throw new Error(`WeComApp send failed: ${response.data.errmsg}`);
  }
}
