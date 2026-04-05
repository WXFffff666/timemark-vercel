import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * Matrix 通知服务
 * https://matrix.org/docs/legacy/client-server-api/
 */
export async function sendMatrixNotification(
  event: any, 
  homeserverUrl: string, 
  accessToken: string, 
  roomId: string
): Promise<void> {
  const blessing = getBlessing(event.type);
  
  const message = `📅 **${event.name}**\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  
  // 确保 homeserver URL 不以斜杠结尾
  const baseUrl = homeserverUrl.replace(/\/$/, '');
  
  // Matrix 发送消息 API
  const txnId = Date.now().toString();
  await axios.put(
    `${baseUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      msgtype: 'm.text',
      body: message,
      format: 'org.matrix.custom.html',
      formatted_body: message.replace(/\n/g, '<br>')
    },
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
}
