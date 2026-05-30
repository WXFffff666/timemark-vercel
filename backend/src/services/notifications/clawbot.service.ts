import axios from 'axios';
import QRCode from 'qrcode';
import { getBlessing } from '../../../../shared/src/blessings.js';

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';

// Store active sessions by session ID
interface ClawBotSession {
  sessionId: string;
  qrcode: string; // raw qrcode value for polling
  bot_token?: string;
  ilink_bot_id?: string;
  baseUrl?: string;
  authenticated: boolean;
  user?: string;
}

const activeSessions = new Map<string, ClawBotSession>();

export interface ClawBotSessionData {
  sessionId: string;
  bot_token: string;
  ilink_bot_id: string;
  baseUrl: string;
  authenticated: boolean;
  user?: string;
}

/**
 * Start QR code authentication flow for ClawBot
 * Calls iLink get_bot_qrcode API and returns a data URL QR image
 */
export async function startAuth(): Promise<{ qrcode: string; sessionId: string }> {
  const sessionId = `clawbot_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

  console.log(`[ClawBot] Starting auth for session ${sessionId}`);

  const { data } = await axios.get(`${ILINK_BASE}/ilink/bot/get_bot_qrcode`, {
    params: { bot_type: 3 },
    timeout: 15000,
  });

  if (!data || !data.qrcode) {
    throw new Error('Failed to get QR code from iLink API');
  }

  // Convert the qrcode URL to a data URL image
  const qrDataUrl = await QRCode.toDataURL(data.qrcode, {
    type: 'image/png',
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });

  activeSessions.set(sessionId, {
    sessionId,
    qrcode: data.qrcode,
    authenticated: false,
  });

  console.log(`[ClawBot] QR code generated for session ${sessionId}`);
  return { qrcode: qrDataUrl, sessionId };
}

/**
 * Check if the session is authenticated by polling iLink qrcode status
 */
export async function checkAuth(sessionData: any): Promise<{ authenticated: boolean; user?: string; sessionData?: string }> {
  try {
    const parsed: ClawBotSessionData = typeof sessionData === 'string'
      ? JSON.parse(sessionData)
      : sessionData;

    if (!parsed || !parsed.sessionId) {
      return { authenticated: false };
    }

    const session = activeSessions.get(parsed.sessionId);
    if (!session) {
      // Session not in memory — check if sessionData already has credentials
      if (parsed.bot_token && parsed.authenticated) {
        const exported = exportSessionData(parsed.sessionId);
        return { authenticated: true, user: parsed.user || parsed.ilink_bot_id, sessionData: exported || undefined };
      }
      return { authenticated: false };
    }

    // Already confirmed
    if (session.authenticated && session.bot_token) {
      return { authenticated: true, user: session.user || session.ilink_bot_id, sessionData: exportSessionData(session.sessionId) || undefined };
    }

    // Poll the qrcode status
    const { data } = await axios.get(`${ILINK_BASE}/ilink/bot/get_qrcode_status`, {
      params: { qrcode: session.qrcode },
      timeout: 10000,
    });

    if (!data || !data.status) {
      return { authenticated: false };
    }

    if (data.status === 'confirmed' && data.bot_token) {
      session.bot_token = data.bot_token;
      session.ilink_bot_id = data.ilink_bot_id || '';
      session.baseUrl = data.baseurl || ILINK_BASE;
      session.authenticated = true;
      session.user = data.ilink_bot_id || 'ClawBot';
      activeSessions.set(parsed.sessionId, session);

      console.log(`[ClawBot] Session ${parsed.sessionId} authenticated as ${session.user}`);
      return { authenticated: true, user: session.user, sessionData: exportSessionData(session.sessionId) || undefined };
    }

    if (data.status === 'expired') {
      activeSessions.delete(parsed.sessionId);
      console.log(`[ClawBot] Session ${parsed.sessionId} QR code expired`);
      return { authenticated: false };
    }

    // "wait" or "scaned" — still pending
    return { authenticated: false };
  } catch (error) {
    console.error('[ClawBot] Error checking auth status:', error);
    return { authenticated: false };
  }
}

/**
 * Logout and clear the session
 */
export async function logout(sessionData: any): Promise<void> {
  try {
    const parsed: ClawBotSessionData = typeof sessionData === 'string'
      ? JSON.parse(sessionData)
      : sessionData;

    if (!parsed || !parsed.sessionId) {
      return;
    }

    activeSessions.delete(parsed.sessionId);
    console.log(`[ClawBot] Session ${parsed.sessionId} logged out and cleaned up`);
  } catch (error) {
    console.error('[ClawBot] Error during logout:', error);
    throw error;
  }
}

/**
 * Export session data for persistent storage
 */
export function exportSessionData(sessionId: string): string | null {
  const session = activeSessions.get(sessionId);
  if (!session || !session.authenticated || !session.bot_token) {
    return null;
  }

  return JSON.stringify({
    sessionId: session.sessionId,
    bot_token: session.bot_token,
    ilink_bot_id: session.ilink_bot_id || '',
    baseUrl: session.baseUrl || ILINK_BASE,
    authenticated: true,
    user: session.user,
  } satisfies ClawBotSessionData);
}

/**
 * Send notification message via ClawBot iLink API
 * Kept as a standalone export for backward compatibility
 */
export async function sendClawBotNotification(
  event: any,
  token: string,
  toUserId: string,
  baseUrl: string = ILINK_BASE
): Promise<void> {
  let text: string;
  if (event.customMessage) {
    text = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    text = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }
  await axios.post(`${baseUrl}/ilink/bot/sendmessage`, {
    toUserId,
    text,
    contextToken: token,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${token}`,
    },
    timeout: 15000,
  });
}
