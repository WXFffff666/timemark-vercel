import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

export async function sendBarkNotification(
  event: any,
  serverUrl: string,
  deviceKey: string,
  group?: string,
  sound?: string
): Promise<void> {
  let title: string;
  let body: string;
  if (event.customMessage) {
    title = `📅 ${event.name}`;
    body = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    title = `📅 ${event.name}`;
    body = `📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }
  const response = await axios.post(`${serverUrl}/push`, {
    device_key: deviceKey,
    title,
    body,
    ...(group ? { group } : {}),
    ...(sound ? { sound } : {}),
  }, { timeout: 15000 });
  if (response.data?.code !== 200) {
    throw new Error(`Bark push failed: ${response.data?.message || 'unknown error'}`);
  }
}
