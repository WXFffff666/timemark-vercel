import QRCode from 'qrcode';
import { getBlessing } from '../../../../shared/src/blessings.js';

// Lazy-loaded wechaty module
let _wechaty: typeof import('wechaty') | null = null;
let _wechatyLoadError: Error | null = null;

async function getWechaty() {
  if (_wechatyLoadError) throw _wechatyLoadError;
  if (!_wechaty) {
    try {
      _wechaty = await import('wechaty');
    } catch {
      _wechatyLoadError = new Error(
        '此渠道需要额外安装 wechaty 包。请运行: pnpm add wechaty，或参考文档: docs/CHANNEL_COMPATIBILITY.md'
      );
      throw _wechatyLoadError;
    }
  }
  return _wechaty;
}

// Store active bot instances by session ID
const botInstances = new Map<string, any>();
const authStatus = new Map<string, { authenticated: boolean; user?: string }>();

export interface WechatySessionData {
  sessionId: string;
  authenticated: boolean;
  user?: string;
}

/**
 * Start QR code authentication flow for WeChat
 * Returns QR code as data URL and session ID for tracking
 */
export async function startAuth(): Promise<{ qrcode: string; sessionId: string }> {
  const { WechatyBuilder, ScanStatus } = await getWechaty();
  const sessionId = `wechaty_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  
  console.log(`[WeChaty] Starting auth for session ${sessionId}`);
  
  return new Promise((resolve, reject) => {
    const bot = WechatyBuilder.build({
      name: `timemark-${sessionId}`,
    });

    let qrCodeData: string | null = null;

    bot
      .on('scan', async (qrcode: string, status: number) => {
        console.log(`[WeChaty] Scan event: status=${status}, qrcode length=${qrcode?.length}`);
        if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {
          // Generate QR code data URL
          const qrDataUrl = await QRCode.toDataURL(qrcode, {
            type: 'image/png',
            width: 400,
            margin: 2,
            color: {
              dark: '#000000',
              light: '#ffffff'
            }
          });
          qrCodeData = qrDataUrl;
          
          // Store bot instance
          botInstances.set(sessionId, bot);
          authStatus.set(sessionId, { authenticated: false });
          
          // Return the QR code immediately
          console.log(`[WeChaty] QR code generated successfully for session ${sessionId}`);
          resolve({ qrcode: qrDataUrl, sessionId });
        }
      })
      .on('login', (user: { name(): string }) => {
        console.log(`[WeChaty] User ${user.name()} logged in for session ${sessionId}`);
        authStatus.set(sessionId, { authenticated: true, user: user.name() });
      })
      .on('logout', (user: { name(): string }) => {
        console.log(`[WeChaty] User ${user.name()} logged out for session ${sessionId}`);
        authStatus.set(sessionId, { authenticated: false });
      })
      .on('error', (error: Error) => {
        console.error(`[WeChaty] Error for session ${sessionId}:`, error);
        if (!qrCodeData) {
          reject(error);
        }
      });

    bot.start().catch((error: Error) => {
      console.error('[WeChaty] Failed to start bot:', error);
      if (!qrCodeData) {
        reject(error);
      }
    });

    // Timeout after 5 minutes if no QR code generated
    setTimeout(() => {
      if (!qrCodeData) {
        bot.stop().catch(console.error);
        botInstances.delete(sessionId);
        reject(new Error('QR code generation timeout'));
      }
    }, 300000);
  });
}

/**
 * Check if the session is authenticated
 * @param sessionData - JSON serialized session data
 */
export async function checkAuth(sessionData: any): Promise<{ authenticated: boolean; user?: string }> {
  try {
    const data: WechatySessionData = typeof sessionData === 'string' 
      ? JSON.parse(sessionData) 
      : sessionData;
    
    if (!data || !data.sessionId) {
      return { authenticated: false };
    }

    const status = authStatus.get(data.sessionId);
    if (status) {
      return status;
    }

    // Check if bot instance exists and is logged in
    const bot = botInstances.get(data.sessionId);
    if (bot && bot.isLoggedIn) {
      const user = bot.currentUser;
      return { authenticated: true, user: user?.name() };
    }

    return { authenticated: false };
  } catch (error) {
    console.error('[WeChaty] Error checking auth status:', error);
    return { authenticated: false };
  }
}

/**
 * Logout and clear the session
 * @param sessionData - JSON serialized session data
 */
export async function logout(sessionData: any): Promise<void> {
  try {
    const data: WechatySessionData = typeof sessionData === 'string' 
      ? JSON.parse(sessionData) 
      : sessionData;
    
    if (!data || !data.sessionId) {
      return;
    }

    const bot = botInstances.get(data.sessionId);
    if (bot) {
      await bot.logout();
      await bot.stop();
    }

    botInstances.delete(data.sessionId);
    authStatus.delete(data.sessionId);
    
    console.log(`[WeChaty] Session ${data.sessionId} logged out and cleaned up`);
  } catch (error) {
    console.error('[WeChaty] Error during logout:', error);
    throw error;
  }
}

/**
 * Send notification message to a WeChat user
 * @param event - Event data with name, date, type, etc.
 * @param sessionData - JSON serialized session data
 * @param toUser - Target user's WeChat name or ID
 */
export async function sendNotification(
  event: any, 
  sessionData: any, 
  toUser: string
): Promise<void> {
  try {
    const data: WechatySessionData = typeof sessionData === 'string' 
      ? JSON.parse(sessionData) 
      : sessionData;
    
    if (!data || !data.sessionId) {
      throw new Error('Invalid session data');
    }

    const bot = botInstances.get(data.sessionId);
    if (!bot) {
      throw new Error('Bot instance not found. Please authenticate first.');
    }

    if (!bot.isLoggedIn) {
      throw new Error('Bot is not logged in. Please re-authenticate.');
    }

    // Format the message
    let message: string;
    if (event.customMessage) {
      message = event.customMessage;
    } else {
      const blessing = getBlessing(
        event.type,
        event.reminderConfig?.customMessage,
        event.personName,
        event.reminderRecipientName
      );
      message = `📅 ${event.name}\n\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}\n\n——来自 TimeMark 提醒`;
    }

    // Find and send to contact - use any to avoid type issues
    const contact = await (bot.Contact as any).find({ name: toUser }) 
      || await (bot.Contact as any).find({ alias: toUser });
    
    if (!contact) {
      throw new Error(`Contact "${toUser}" not found. Please make sure you are friends with this user.`);
    }

    await (contact as any).say(message);
    console.log(`[WeChaty] Message sent to ${toUser} for session ${data.sessionId}`);
  } catch (error) {
    console.error('[WeChaty] Error sending notification:', error);
    throw error;
  }
}

/**
 * Serialize session data for storage
 * @param sessionId - Session ID
 * @param authenticated - Authentication status
 * @param user - User name (optional)
 */
export function serializeSession(sessionId: string, authenticated: boolean = false, user?: string): string {
  return JSON.stringify({ sessionId, authenticated, user });
}
