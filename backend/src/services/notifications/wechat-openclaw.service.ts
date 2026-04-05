import axios, { AxiosInstance } from 'axios';
import { spawn, ChildProcess } from 'child_process';
import QRCode from 'qrcode';
import { getBlessing } from '../../../../shared/src/blessings.js';

// Message type constants (matching OpenClaw protocol)
const MsgType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

// In-memory storage for active sessions
const activeSessions = new Map<string, OpenClawSession>();

interface OpenClawSession {
  sessionId: string;
  authenticated: boolean;
  user?: string;
  token?: string;
  wechatUin?: string;
  baseUrl: string;
  httpClient: AxiosInstance;
  process?: ChildProcess;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `openclaw_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Get or create HTTP client for the session
 */
function createHttpClient(baseUrl: string, token?: string): AxiosInstance {
  return axios.create({
    baseURL: baseUrl,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  });
}

/**
 * Start QR code authentication flow
 * This starts the OpenClaw plugin process and returns QR code for login
 * @returns Object containing QR code data URL and session ID
 */
export async function startAuth(): Promise<{ qrcode: string; sessionId: string }> {
  const sessionId = generateSessionId();
  const baseUrl = 'http://localhost:8080'; // Default OpenClaw HTTP port

  // Try to start the plugin process (optional - if already running, this will fail gracefully)
  let pluginProcess: ChildProcess | undefined;
  try {
    pluginProcess = spawn('npx', ['@tencent-weixin/openclaw-weixin', '--http'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Capture stdout for QR code or status
    let qrCodeData: string | null = null;

    pluginProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      console.log('[OpenClaw]', output);
      
      // Try to extract QR code URL from output
      // The plugin outputs QR code URL when ready
      const qrMatch = output.match(/qrcode[=:]\s*(https?:\/\/[^\s]+)/i);
      if (qrMatch && !qrCodeData) {
        // Generate QR code from URL
        QRCode.toDataURL(qrMatch[1], {
          type: 'image/png',
          width: 400,
          margin: 2,
        }).then((dataUrl) => {
          qrCodeData = dataUrl;
        });
      }
    });

    pluginProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[OpenClaw stderr]', data.toString());
    });

    // Wait for plugin to be ready (brief delay)
    await new Promise(resolve => setTimeout(resolve, 2000));
  } catch (error) {
    console.log('[OpenClaw] Plugin may already be running, continuing with HTTP API');
  }

  // Create session
  const httpClient = createHttpClient(baseUrl);
  
  const session: OpenClawSession = {
    sessionId,
    authenticated: false,
    baseUrl,
    httpClient,
    process: pluginProcess,
  };

  activeSessions.set(sessionId, session);

  // Try to get QR code from API
  try {
    const response = await httpClient.get('/api/qrcode', { timeout: 5000 });
    if (response.data && response.data.qrcode) {
      const qrDataUrl = await QRCode.toDataURL(response.data.qrcode, {
        type: 'image/png',
        width: 400,
        margin: 2,
      });
      return { qrcode: qrDataUrl, sessionId };
    }
  } catch (error) {
    // API not ready yet, return placeholder QR
  }

  // Return a placeholder QR code (user scans with WeChat)
  const placeholderQr = await QRCode.toDataURL('https://open.weixin.qq.com/connect/qrcode', {
    type: 'image/png',
    width: 400,
    margin: 2,
  });

  return { qrcode: placeholderQr, sessionId };
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
    // Try to restore session from stored token
    if (sessionData.token && sessionData.baseUrl) {
      const restoredSession: OpenClawSession = {
        sessionId: sessionData.sessionId,
        authenticated: true,
        token: sessionData.token,
        wechatUin: sessionData.wechatUin,
        baseUrl: sessionData.baseUrl,
        httpClient: createHttpClient(sessionData.baseUrl, sessionData.token),
      };
      activeSessions.set(sessionData.sessionId, restoredSession);
      
      // Verify token is valid
      try {
        await restoredSession.httpClient.get('/api/config');
        return { authenticated: true, user: sessionData.wechatUin };
      } catch {
        return { authenticated: false };
      }
    }
    return { authenticated: false };
  }

  if (!session.authenticated) {
    // Check if we have a token and verify it
    if (session.token) {
      try {
        await session.httpClient.get('/api/config');
        session.authenticated = true;
        return { authenticated: true, user: session.wechatUin };
      } catch {
        return { authenticated: false };
      }
    }
    return { authenticated: false };
  }

  return {
    authenticated: session.authenticated,
    user: session.wechatUin,
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
      // Notify the plugin about logout
      if (session.token) {
        await session.httpClient.post('/api/logout', {}, {
          headers: { 'Authorization': `Bearer ${session.token}` },
        }).catch(() => {});
      }
      
      // Kill the plugin process if we started it
      if (session.process) {
        session.process.kill();
      }
    } catch (error) {
      console.error('[OpenClaw] Error during logout:', error);
    } finally {
      activeSessions.delete(sessionData.sessionId);
    }
  }
}

/**
 * Send notification message to a WeChat user
 * @param event - The event to send notification for
 * @param sessionData - The session data containing sessionId
 * @param toUser - The target WeChat user ID or name
 */
export async function sendNotification(event: any, sessionData: any, toUser: string): Promise<void> {
  if (!sessionData || !sessionData.sessionId) {
    throw new Error('Invalid session data');
  }

  const session = activeSessions.get(sessionData.sessionId);
  if (!session) {
    throw new Error('Session not found. Please authenticate first.');
  }

  if (!session.authenticated || !session.token) {
    throw new Error('Session not authenticated. Please complete QR login.');
  }

  // Get blessing message
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );

  // Format message
  const message = `📅 ${event.name}

📆 日期: ${event.date}
🏷️ 类型: ${event.type}

🎉 ${blessing}

——来自 TimeMark 提醒`;

  try {
    // Send text message using OpenClaw API
    const response = await session.httpClient.post('/api/sendMessage', {
      type: MsgType.TEXT,
      to: toUser,
      content: message,
    }, {
      headers: { 'Authorization': `Bearer ${session.token}` },
    });

    if (response.data?.success) {
      console.log(`[OpenClaw] Message sent to ${toUser}`);
    } else {
      throw new Error(response.data?.message || 'Failed to send message');
    }
  } catch (error: any) {
    console.error('[OpenClaw] Failed to send notification:', error.message);
    throw new Error(`Failed to send notification: ${error.message}`);
  }
}

/**
 * Send image message
 */
export async function sendImage(sessionData: any, toUser: string, imagePath: string): Promise<void> {
  if (!sessionData || !sessionData.sessionId) {
    throw new Error('Invalid session data');
  }

  const session = activeSessions.get(sessionData.sessionId);
  if (!session || !session.token) {
    throw new Error('Session not authenticated');
  }

  try {
    await session.httpClient.post('/api/sendMessage', {
      type: MsgType.IMAGE,
      to: toUser,
      content: imagePath,
    }, {
      headers: { 'Authorization': `Bearer ${session.token}` },
    });
  } catch (error: any) {
    throw new Error(`Failed to send image: ${error.message}`);
  }
}

/**
 * Send file message
 */
export async function sendFile(sessionData: any, toUser: string, filePath: string): Promise<void> {
  if (!sessionData || !sessionData.sessionId) {
    throw new Error('Invalid session data');
  }

  const session = activeSessions.get(sessionData.sessionId);
  if (!session || !session.token) {
    throw new Error('Session not authenticated');
  }

  try {
    await session.httpClient.post('/api/sendMessage', {
      type: MsgType.FILE,
      to: toUser,
      content: filePath,
    }, {
      headers: { 'Authorization': `Bearer ${session.token}` },
    });
  } catch (error: any) {
    throw new Error(`Failed to send file: ${error.message}`);
  }
}

/**
 * Send typing status
 */
export async function sendTyping(sessionData: any, toUser: string, typing: boolean = true): Promise<void> {
  if (!sessionData || !sessionData.sessionId) {
    throw new Error('Invalid session data');
  }

  const session = activeSessions.get(sessionData.sessionId);
  if (!session || !session.token) {
    throw new Error('Session not authenticated');
  }

  try {
    await session.httpClient.post('/api/sendTyping', {
      to: toUser,
      typing,
    }, {
      headers: { 'Authorization': `Bearer ${session.token}` },
    });
  } catch (error: any) {
    // Typing status is optional, don't throw
    console.warn('[OpenClaw] Failed to send typing status:', error.message);
  }
}

/**
 * Get updates (long-poll for new messages)
 */
export async function getUpdates(sessionData: any, timeout: number = 30): Promise<any[]> {
  if (!sessionData || !sessionData.sessionId) {
    throw new Error('Invalid session data');
  }

  const session = activeSessions.get(sessionData.sessionId);
  if (!session || !session.token) {
    throw new Error('Session not authenticated');
  }

  try {
    const response = await session.httpClient.get('/api/getUpdates', {
      timeout: timeout * 1000,
      headers: { 'Authorization': `Bearer ${session.token}` },
    });
    return response.data?.updates || [];
  } catch (error: any) {
    if (error.code === 'ECONNABORTED') {
      // Timeout is expected for long-polling
      return [];
    }
    throw new Error(`Failed to get updates: ${error.message}`);
  }
}

/**
 * Get account config
 */
export async function getConfig(sessionData: any): Promise<any> {
  if (!sessionData || !sessionData.sessionId) {
    throw new Error('Invalid session data');
  }

  const session = activeSessions.get(sessionData.sessionId);
  if (!session || !session.token) {
    throw new Error('Session not authenticated');
  }

  try {
    const response = await session.httpClient.get('/api/config', {
      headers: { 'Authorization': `Bearer ${session.token}` },
    });
    return response.data;
  } catch (error: any) {
    throw new Error(`Failed to get config: ${error.message}`);
  }
}

/**
 * Export session data for storage
 * @param sessionId - The session ID
 * @returns Serialized session data
 */
export function exportSessionData(sessionId: string): any {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return null;
  }

  return {
    sessionId,
    authenticated: session.authenticated,
    user: session.wechatUin,
    token: session.token,
    wechatUin: session.wechatUin,
    baseUrl: session.baseUrl,
  };
}
