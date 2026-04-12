import QRCode from 'qrcode';
import { getBlessing } from '../../../../shared/src/blessings.js';

let oicq: typeof import('oicq') | undefined;
let oicqLoadError: Error | undefined;

async function loadOicq() {
  if (!oicq) {
    try {
      oicq = await import('oicq');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[QQBot] Failed to load oicq module:', errMsg);
      oicqLoadError = new Error(`认证启动失败: npm包oicq未正确安装，请确保已执行 pnpm install。详细信息: ${errMsg}`);
      throw oicqLoadError;
    }
  }
}

function getOicq() {
  if (oicqLoadError) {
    throw oicqLoadError;
  }
  if (!oicq) {
    throw new Error('认证启动失败: npm包oicq未正确安装，请确保已执行 pnpm install');
  }
  return oicq;
}

// In-memory storage for active sessions (in production, use Redis or database)
const activeSessions = new Map<string, { client: any; qqNumber: string; authenticated: boolean; user?: string }>();

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `qqbot_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Start QR code authentication flow for the given QQ number
 * @param qqNumber - The QQ number to authenticate
 * @returns Object containing QR code data URL and session ID
 */
export async function startAuth(qqNumber: string): Promise<{ qrcode: string; sessionId: string }> {
  await loadOicq();
  const oicqModule = getOicq();
  
  const sessionId = generateSessionId();
  
  return new Promise((resolve, reject) => {
    try {
      const client = oicqModule.createClient(Number(qqNumber), {
        platform: oicqModule.Platform.iPad,
        log_level: 'info',
      });

      let qrCodeData: string | null = null;

      // Handle QR code event
      client.on('system.login.qrcode', async (event) => {
        try {
          // Generate QR code data URL from the image buffer
          const qrBuffer = event.image;
          qrCodeData = await QRCode.toDataURL(qrBuffer.toString('base64'), {
            type: 'image/png',
            margin: 2,
            scale: 8,
          });
          
          // Store session
          activeSessions.set(sessionId, {
            client,
            qqNumber,
            authenticated: false,
          });

          resolve({
            qrcode: qrCodeData,
            sessionId,
          });
        } catch (error) {
          reject(error);
        }
      });

      // Handle successful login
      client.on('system.login', () => {
        const session = activeSessions.get(sessionId);
        if (session) {
          session.authenticated = true;
          session.user = qqNumber;
        }
      });

      // Handle online event
      client.on('system.online', () => {
        const session = activeSessions.get(sessionId);
        if (session) {
          session.authenticated = true;
          session.user = qqNumber;
        }
      });

      // Handle login error
      client.on('system.login.error', (error) => {
        reject(new Error(`Login error: ${error.message}`));
      });

      // Handle slider captcha (if needed)
      client.on('system.login.slider', async () => {
        // For slider captcha, we need to handle it differently
        // This is a placeholder - in production you'd need to get the slider ticket
        console.log('[QQBot] Slider captcha required - please use QR code login');
        reject(new Error('Slider captcha not supported, please use QR code login'));
      });

      // Handle device lock (if needed)
      client.on('system.login.device', () => {
        client.login();
      });

      // Start login process
      client.login();

    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Check if the session is authenticated
 * @param sessionData - The session data containing sessionId
 * @returns Object with authentication status and user info
 */
export async function checkAuth(sessionData: any): Promise<{ authenticated: boolean; user?: string }> {
  if (!sessionData || !sessionData.sessionId) {
    return { authenticated: false };
  }

  const session = activeSessions.get(sessionData.sessionId);
  if (!session) {
    return { authenticated: false };
  }

  return {
    authenticated: session.authenticated,
    user: session.user,
  };
}

/**
 * Logout and clear the session
 * @param sessionData - The session data containing sessionId
 */
export async function logout(sessionData: any): Promise<void> {
  if (!sessionData || !sessionData.sessionId) {
    return;
  }

  const session = activeSessions.get(sessionData.sessionId);
  if (session) {
    try {
      // Logout from the client
      session.client.logout(true);
    } catch (error) {
      console.error('Error during logout:', error);
    } finally {
      // Remove from active sessions
      activeSessions.delete(sessionData.sessionId);
    }
  }
}

/**
 * Send notification message to a QQ user
 * @param event - The event to send notification for
 * @param sessionData - The session data containing sessionId
 * @param toUser - The target QQ number to send message to
 */
export async function sendNotification(event: any, sessionData: any, toUser: string): Promise<void> {
  if (!sessionData || !sessionData.sessionId) {
    throw new Error('Invalid session data');
  }

  const session = activeSessions.get(sessionData.sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  if (!session.authenticated) {
    throw new Error('Session not authenticated');
  }

  // Get blessing message
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );

  // Format message similar to other services
  const message = `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;

  try {
    // Send private message to the target user
    await session.client.sendPrivateMsg(Number(toUser), message);
  } catch (error) {
    console.error('Failed to send QQ notification:', error);
    throw new Error(`Failed to send notification: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Export session data for storage (serialization)
 * @param sessionId - The session ID
 * @returns Serialized session data
 */
export function exportSessionData(sessionId: string): any {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return null;
  }

  // Return session data that can be stored
  // Note: The actual oicq device JSON is managed internally by the client
  return {
    sessionId,
    qqNumber: session.qqNumber,
    authenticated: session.authenticated,
    user: session.user,
  };
}
