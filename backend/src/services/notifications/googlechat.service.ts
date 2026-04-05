import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * Google Chat Webhook 通知服务
 * https://developers.google.com/chat/how-tos/webhooks
 */
export async function sendGoogleChatNotification(event: any, webhook: string): Promise<void> {
  const blessing = getBlessing(event.type);
  
  const message = {
    text: `📅 *${event.name}*\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`,
    cards: [
      {
        header: {
          title: '📅 TimeMark 提醒',
          subtitle: event.name,
        },
        sections: [
          {
            widgets: [
              {
                keyValue: {
                  topLabel: '日期',
                  content: event.date,
                }
              },
              {
                keyValue: {
                  topLabel: '类型',
                  content: event.type,
                }
              },
              {
                textParagraph: {
                  text: `🎉 ${blessing}`
                }
              }
            ]
          }
        ]
      }
    ]
  };

  await axios.post(webhook, message);
}
