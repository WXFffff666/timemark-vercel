import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * Zalo Official Account API 通知服务
 * https://developers.zalo.me/docs/api/oa/create-message-9
 */

const ZALO_API_BASE = 'https://api.zalo.me/v2.0/oa';

/**
 * 获取 Zalo OA 信息
 */
export async function getOAInfo(accessToken: string): Promise<any> {
  const response = await axios.get(`${ZALO_API_BASE}/getOA`, {
    headers: {
      'Access_token': accessToken,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
  return response.data;
}

/**
 * 获取关注者列表
 */
export async function getFollowers(accessToken: string, offset: number = 0, count: number = 100): Promise<any> {
  const response = await axios.post(`${ZALO_API_BASE}/getfollowers`, {
    offset,
    count
  }, {
    headers: {
      'Access_token': accessToken,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
  return response.data;
}

/**
 * 发送 Zalo 消息
 */
export async function sendZaloMessage(
  accessToken: string,
  userId: string,
  message: string
): Promise<any> {
  const response = await axios.post(`${ZALO_API_BASE}/message`, {
    recipient: {
      user_id: userId
    },
    message: {
      text: message
    }
  }, {
    headers: {
      'Access_token': accessToken,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
  return response.data;
}

/**
 * 启动认证流程
 * Zalo OA 使用访问令牌认证，此方法返回配置说明
 */
export async function startAuth(credentials: {
  access_token: string;
  oauth_token?: string;
}): Promise<{ qrcode: string; sessionId: string }> {
  // Zalo OA requires access_token from the Zalo OA Dashboard
  // This is a simplified implementation that returns setup instructions
  
  const sessionId = `zalo_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  
  // Validate credentials by attempting to get OA info
  if (!credentials.access_token) {
    throw new Error('Zalo access_token is required. Please obtain it from Zalo OA Dashboard.');
  }
  
  try {
    await getOAInfo(credentials.access_token);
  } catch (error: any) {
    if (error.response?.data?.error === -202) {
      throw new Error('Invalid access_token. Please check your Zalo OA credentials.');
    }
    throw error;
  }
  
  // Return instruction message (Zalo OA doesn't have QR code auth like WhatsApp)
  const qrcode = 'Zalo OA uses access_token authentication. No QR code needed.';
  
  return { qrcode, sessionId };
}

/**
 * 检查认证状态
 */
export async function checkAuth(sessionData: any): Promise<{ authenticated: boolean }> {
  if (!sessionData || !sessionData.credentials?.access_token) {
    return { authenticated: false };
  }
  
  try {
    await getOAInfo(sessionData.credentials.access_token);
    return { authenticated: true };
  } catch (error) {
    return { authenticated: false };
  }
}

/**
 * 登出（清除会话数据）
 */
export async function logout(sessionData: any): Promise<void> {
  // Zalo OA doesn't have session state to clear
  // Just clear the in-memory references if any
  if (sessionData) {
    delete sessionData.credentials;
  }
}

/**
 * 发送通知
 */
export async function sendNotification(
  event: any,
  sessionData: any,
  toUser: string
): Promise<void> {
  if (!sessionData || !sessionData.credentials?.access_token) {
    throw new Error('Invalid session data. Zalo access_token is required.');
  }
  
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  
  const message = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  
  await sendZaloMessage(
    sessionData.credentials.access_token,
    toUser,
    message
  );
}
