import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

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

  const url = `${serverUrl.replace(/\/$/, '')}/${topic}`;
  await axios.post(url, message, {
    headers: {
      'Title': `TimeMark: ${event.name}`,
      'Priority': '3',
      'Tags': 'calendar',
    },
    timeout: 10000,
  });
}
