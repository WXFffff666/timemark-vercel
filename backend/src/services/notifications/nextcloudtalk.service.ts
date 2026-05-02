import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * Nextcloud Talk 通知服务
 */
export async function sendNextcloudTalkNotification(
  event: any, 
  nextcloudUrl: string, 
  appPassword: string, 
  roomToken: string
): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  
  const message = `📅 **${event.name}**\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  
  // 确保 URL 不以斜杠结尾
  const baseUrl = nextcloudUrl.replace(/\/$/, '');
  
  await axios.post(
    `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/chat/${roomToken}`,
    {
      message: message
    },
    {
      headers: {
        'Authorization': `Basic ${Buffer.from(`:${appPassword}`).toString('base64')}`,
        'OCS-APIRequest': 'true',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );
}
