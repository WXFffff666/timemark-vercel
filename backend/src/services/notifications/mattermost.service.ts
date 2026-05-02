import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * Mattermost API 通知服务
 * https://developers.mattermost.com/integrate/reference/bot-accounts/
 */
export async function sendMattermostNotification(
  event: any, 
  serverUrl: string, 
  botToken: string, 
  channelId: string
): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  
  const message = `📅 **${event.name}**\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  
  // 确保 URL 不以斜杠结尾
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  await axios.post(
    `${baseUrl}/api/v4/posts`,
    {
      channel_id: channelId,
      message: message
    },
    {
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );
}
