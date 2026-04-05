import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * Microsoft Teams Bot 通知服务
 * https://docs.microsoft.com/en-us/microsoftteams/platform/bots/what-are-bots
 */
export async function sendMicrosoftTeamsNotification(
  event: any, 
  botToken: string, 
  conversationId: string
): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  
  const message = {
    type: 'message',
    text: `📅 **${event.name}**\n\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`
  };
  
  await axios.post(
    `https://smba.trafficmanager.net/apis/v3/conversations/${conversationId}/activities`,
    message,
    {
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
}
