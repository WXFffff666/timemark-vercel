import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendAppriseNotification(
  event: any,
  serverUrl: string,
  urls?: string
): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const message = event.customMessage || `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;

  const payload: Record<string, string> = {
    title: `TimeMark: ${event.name}`,
    body: message,
    type: 'info',
  };
  if (urls) payload.urls = urls;

  await axios.post(`${serverUrl.replace(/\/$/, '')}/notify`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}
