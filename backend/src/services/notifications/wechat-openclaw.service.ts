import axios, { AxiosInstance } from 'axios';
import { spawn, execSync, ChildProcess } from 'child_process';
import QRCode from 'qrcode';
import { getBlessing } from '../../../../shared/src/blessings.js';
import { query } from '../../db/index.js';
import { encrypt, decrypt } from '@timemark/shared/crypto';

// ============================================================================
// OpenClaw 微信插件服务
// 
// 依赖: OpenClaw CLI (https://docs.openclaw.ai/install) + @tencent-weixin/openclaw-weixin 插件
// 
// 注意: 此渠道需要宿主环境安装 OpenClaw CLI 并完成插件配置。
// 在 Docker 环境中需要额外配置，建议优先使用 WxPusher 渠道。
// 
// 状态: 实验性 (Experimental) - 插件可用但环境配置复杂
// ============================================================================

// Message type constants (matching OpenClaw protocol)
const MsgType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

// Auth flow timeout (30 seconds for QR code generation)
const AUTH_TIMEOUT_MS = 30_000;

// Health check interval (60 seconds)
const HEALTH_CHECK_INTERVAL_MS = 60_000;

// In-memory storage for active sessions (cache, DB is source of truth)
const activeSessions = new Map<string, OpenClawSession>();

// Session timeout: 5 minutes
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// Health check timer
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

function getMasterKey(): string {
  return process.env.MASTER_KEY || 'timemark-default-master-key-change-in-production-2026';
}

/**
 * Persist session to SQLite database (excludes non-serializable fields like process/httpClient)
 */
async function persistSession(session: OpenClawSession): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_TIMEOUT_MS).toISOString();
  const status = session.authenticated ? 'authenticated' : 'pending';
  const serializable = {
    sessionId: session.sessionId,
    authenticated: session.authenticated,
    user: session.user,
    token: session.token,
    wechatUin: session.wechatUin,
    baseUrl: session.baseUrl,
  };
  const sessionData = encrypt(JSON.stringify(serializable), getMasterKey());

  await query(
    `INSERT OR REPLACE INTO plugin_sessions (channel_type, session_id, session_data, status, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    ['openclaw', session.sessionId, sessionData, status, expiresAt]
  );
}

/**
 * Load session from SQLite database into cache
 */
async function loadSessionFromDb(sessionId: string): Promise<OpenClawSession | null> {
  const result = await query(
    `SELECT session_data, status FROM plugin_sessions WHERE session_id = $1 AND expires_at > datetime('now')`,
    [sessionId]
  );
  if (result.rows.length === 0) return null;

  try {
    const decrypted = decrypt(result.rows[0].session_data, getMasterKey());
    const data = JSON.parse(decrypted);
    const session: OpenClawSession = {
      ...data,
      httpClient: createHttpClient(data.baseUrl, data.token),
    };
    activeSessions.set(sessionId, session);
    return session;
  } catch {
    return null;
  }
}

/**
 * Delete session from both cache and database
 */
async function deleteSession(sessionId: string): Promise<void> {
  activeSessions.delete(sessionId);
  await query(`DELETE FROM plugin_sessions WHERE session_id = $1`, [sessionId]);
}

interface OpenClawSession {
  sessionId: string;
  authenticated: boolean;
  user?: string;
  token?: string;
  wechatUin?: string;
  baseUrl: string;
  httpClient: AxiosInstance;
  process?: ChildProcess;
  processHealthy?: boolean;
}

/**
 * Check if OpenClaw CLI and plugin are available in the environment
 * @returns true if openclaw CLI is accessible and the weixin plugin is installed
 */
export function isAvailable(): boolean {
  try {
    execSync('openclaw --version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
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
 * Kill a child process safely with timeout
 */
function killProcess(proc: ChildProcess): void {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGTERM');
    // Force kill after 5 seconds if still alive
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  } catch {
    // Process already dead
  }
}

/**
 * Start health check monitoring for active sessions with processes
 */
function startHealthCheck(): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(() => {
    for (const [sessionId, session] of activeSessions) {
      if (session.process && !session.process.killed) {
        // Process is still running
        session.processHealthy = true;
      } else if (session.process) {
        // Process died unexpectedly
        console.warn(`[OpenClaw] 进程已退出，会话 ${sessionId} 标记为不健康`);
        session.processHealthy = false;
        session.authenticated = false;
      }
    }
    // Stop health check if no active sessions with processes
    const hasProcessSessions = [...activeSessions.values()].some(s => s.process);
    if (!hasProcessSessions && healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Cleanup all sessions and processes on exit
 */
function cleanupOnExit(): void {
  for (const [, session] of activeSessions) {
    if (session.process) {
      killProcess(session.process);
    }
  }
  activeSessions.clear();
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// Register cleanup handlers
process.on('exit', cleanupOnExit);
process.on('SIGINT', cleanupOnExit);
process.on('SIGTERM', cleanupOnExit);

/**
 * Start QR code authentication flow
 * This starts the OpenClaw login process and returns QR code for scanning
 * @returns Object containing QR code data URL and session ID
 */
export async function startAuth(): Promise<{ qrcode: string; sessionId: string }> {
  // Check if OpenClaw CLI is available
  if (!isAvailable()) {
    throw new Error(
      'OpenClaw 微信插件暂不可用。需要在宿主环境安装 OpenClaw CLI (https://docs.openclaw.ai/install)。' +
      '在 Docker 环境中配置较复杂，建议使用 WxPusher 渠道作为替代。'
    );
  }

  const sessionId = generateSessionId();
  const baseUrl = 'http://localhost:8080'; // Default OpenClaw gateway port

  // Start the login process using openclaw CLI (correct approach)
  let pluginProcess: ChildProcess | undefined;
  let qrCodeUrl: string | null = null;

  try {
    pluginProcess = spawn('openclaw', ['channels', 'login', '--channel', 'openclaw-weixin'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Wait for QR code output with timeout
    qrCodeUrl = await new Promise<string | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve(null);
      }, AUTH_TIMEOUT_MS);

      let outputBuffer = '';

      pluginProcess!.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        outputBuffer += output;
        console.log('[OpenClaw]', output.trim());

        // OpenClaw outputs QR code URL in various formats
        const qrMatch = outputBuffer.match(/https:\/\/login\.weixin\.qq\.com\/qrcode\/[^\s"']+/i)
          || outputBuffer.match(/https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect[^\s"']+/i)
          || outputBuffer.match(/qr(?:code)?[_\-]?(?:url|link)?[=:]\s*(https?:\/\/[^\s"']+)/i);

        if (qrMatch) {
          clearTimeout(timeout);
          resolve(qrMatch[1] || qrMatch[0]);
        }
      });

      pluginProcess!.stderr?.on('data', (data: Buffer) => {
        const errOutput = data.toString();
        console.error('[OpenClaw stderr]', errOutput.trim());
        // Check for fatal errors
        if (errOutput.includes('not found') || errOutput.includes('未安装')) {
          clearTimeout(timeout);
          reject(new Error('OpenClaw 微信插件未安装。请运行: openclaw plugins install "@tencent-weixin/openclaw-weixin"'));
        }
      });

      pluginProcess!.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`OpenClaw 进程启动失败: ${err.message}`));
      });

      pluginProcess!.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0 && !qrCodeUrl) {
          resolve(null);
        }
      });
    });
  } catch (error: any) {
    if (pluginProcess) killProcess(pluginProcess);
    throw new Error(`OpenClaw 认证启动失败: ${error.message}`);
  }

  // Create session
  const httpClient = createHttpClient(baseUrl);

  const session: OpenClawSession = {
    sessionId,
    authenticated: false,
    baseUrl,
    httpClient,
    process: pluginProcess,
    processHealthy: true,
  };

  activeSessions.set(sessionId, session);
  await persistSession(session);
  startHealthCheck();

  // Generate QR code image from URL
  if (qrCodeUrl) {
    try {
      const qrDataUrl = await QRCode.toDataURL(qrCodeUrl, {
        type: 'image/png',
        width: 400,
        margin: 2,
      });
      return { qrcode: qrDataUrl, sessionId };
    } catch {
      // Fall through to placeholder
    }
  }

  // Try to get QR code from gateway API as fallback
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
  } catch {
    // Gateway not ready
  }

  // If we couldn't get a QR code at all, throw with helpful message
  throw new Error(
    'OpenClaw 二维码获取超时。请确认: 1) OpenClaw gateway 已启动 (openclaw gateway start) ' +
    '2) 微信插件已安装并启用 3) 网络连接正常'
  );
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

  let session = activeSessions.get(sessionData.sessionId) || await loadSessionFromDb(sessionData.sessionId) || null;
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
      await persistSession(restoredSession);
      
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
        await persistSession(session);
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

      // Kill the plugin process safely
      if (session.process) {
        killProcess(session.process);
      }
    } catch (error) {
      console.error('[OpenClaw] 登出时出错:', error);
    } finally {
      await deleteSession(sessionData.sessionId);
    }
  } else {
    // Session not in cache but may be in DB
    await deleteSession(sessionData.sessionId);
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

  const session = activeSessions.get(sessionData.sessionId) || await loadSessionFromDb(sessionData.sessionId);
  if (!session) {
    throw new Error('会话未找到，请重新认证。');
  }

  if (!session.authenticated || !session.token) {
    throw new Error('会话未认证，请先完成扫码登录。');
  }

  if (session.processHealthy === false) {
    throw new Error('OpenClaw 进程已退出，请重新认证。');
  }

  // Format message
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

  const session = activeSessions.get(sessionData.sessionId) || await loadSessionFromDb(sessionData.sessionId);
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

  const session = activeSessions.get(sessionData.sessionId) || await loadSessionFromDb(sessionData.sessionId);
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

  const session = activeSessions.get(sessionData.sessionId) || await loadSessionFromDb(sessionData.sessionId);
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

  const session = activeSessions.get(sessionData.sessionId) || await loadSessionFromDb(sessionData.sessionId);
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

// ============================================================================
// Connection Status & Auto-Reconnect
// ============================================================================

type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting' | null;

interface ReconnectState {
  retryCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  status: ConnectionStatus;
}

const reconnectStates = new Map<number, ReconnectState>();

const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000];
const MAX_RETRIES = 10;
const OPENCLAW_HEARTBEAT_INTERVAL_MS = 60_000;
let openclawHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Update connection_status in the database for a notification account
 */
async function updateConnectionStatus(accountId: number, status: ConnectionStatus): Promise<void> {
  try {
    await query(
      `UPDATE notification_accounts SET connection_status = $1, updated_at = datetime('now') WHERE id = $2`,
      [status, accountId]
    );
  } catch (error) {
    console.error(`[OpenClaw] Failed to update connection_status for account ${accountId}:`, error);
  }
}

/**
 * Check if an OpenClaw session is still alive
 * Verifies by calling the gateway API with the session token
 */
async function checkOpenClawConnection(token: string, baseUrl: string): Promise<boolean> {
  try {
    const client = createHttpClient(baseUrl, token);
    const response = await client.get('/api/config', { timeout: 10000 });
    return !!(response.data);
  } catch {
    return false;
  }
}

/**
 * Attempt to reconnect a disconnected OpenClaw account
 */
async function attemptReconnect(accountId: number, token: string, baseUrl: string): Promise<boolean> {
  const isValid = await checkOpenClawConnection(token, baseUrl);
  if (isValid) {
    await updateConnectionStatus(accountId, 'connected');
    const state = reconnectStates.get(accountId);
    if (state) {
      state.status = 'connected';
      state.retryCount = 0;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    reconnectStates.delete(accountId);
    console.log(`[OpenClaw] Account ${accountId} reconnected successfully`);
    return true;
  }
  return false;
}

/**
 * Schedule reconnect with exponential backoff
 */
function scheduleReconnect(accountId: number, token: string, baseUrl: string): void {
  let state = reconnectStates.get(accountId);
  if (!state) {
    state = { retryCount: 0, timer: null, status: 'reconnecting' };
    reconnectStates.set(accountId, state);
  }

  if (state.retryCount >= MAX_RETRIES) {
    console.warn(`[OpenClaw] Account ${accountId} exceeded max retries (${MAX_RETRIES}), giving up`);
    state.status = 'disconnected';
    updateConnectionStatus(accountId, 'disconnected');
    reconnectStates.delete(accountId);
    return;
  }

  const delay = BACKOFF_DELAYS[Math.min(state.retryCount, BACKOFF_DELAYS.length - 1)];
  state.retryCount++;
  state.status = 'reconnecting';
  updateConnectionStatus(accountId, 'reconnecting');

  console.log(`[OpenClaw] Account ${accountId} reconnect attempt ${state.retryCount}/${MAX_RETRIES} in ${delay}ms`);

  state.timer = setTimeout(async () => {
    const success = await attemptReconnect(accountId, token, baseUrl);
    if (!success) {
      scheduleReconnect(accountId, token, baseUrl);
    }
  }, delay);
}

/**
 * Run heartbeat check for all active OpenClaw accounts
 */
async function runHeartbeat(): Promise<void> {
  try {
    const result = await query(
      `SELECT id, session_data, connection_status FROM notification_accounts WHERE type = 'wechat_openclaw' AND config_method = 'plugin' AND is_active = 1`,
      []
    );

    for (const row of result.rows) {
      if (reconnectStates.has(row.id)) continue;

      let token: string | null = null;
      let baseUrl = 'http://localhost:8080';

      if (row.session_data) {
        try {
          const masterKey = process.env.MASTER_KEY || 'timemark-default-master-key-change-in-production-2026';
          let sessionStr: string;
          try {
            sessionStr = decrypt(row.session_data, masterKey);
          } catch {
            sessionStr = row.session_data;
          }
          const sessionData = typeof sessionStr === 'string' ? JSON.parse(sessionStr) : sessionStr;
          token = sessionData.token || null;
          baseUrl = sessionData.baseUrl || 'http://localhost:8080';
        } catch {
          // Can't parse session data
        }
      }

      if (!token) continue;

      // Also check if the in-memory process is alive
      const cachedSession = [...activeSessions.values()].find(s => {
        // Match by token
        return s.token === token;
      });

      let isConnected = false;
      if (cachedSession?.process && !cachedSession.process.killed) {
        // Process is alive, verify API too
        isConnected = await checkOpenClawConnection(token, baseUrl);
      } else {
        // No process in memory, just check API
        isConnected = await checkOpenClawConnection(token, baseUrl);
      }

      if (isConnected) {
        if (row.connection_status !== 'connected') {
          await updateConnectionStatus(row.id, 'connected');
        }
      } else {
        console.warn(`[OpenClaw] Account ${row.id} connection lost, starting reconnect`);
        await updateConnectionStatus(row.id, 'disconnected');
        scheduleReconnect(row.id, token, baseUrl);
      }
    }
  } catch (error) {
    console.error('[OpenClaw] Heartbeat check failed:', error);
  }
}

/**
 * Start periodic heartbeat monitoring for OpenClaw accounts
 */
export function startHeartbeatMonitor(): void {
  if (openclawHeartbeatTimer) return;
  openclawHeartbeatTimer = setInterval(runHeartbeat, OPENCLAW_HEARTBEAT_INTERVAL_MS);
  setTimeout(runHeartbeat, 5000);
  console.log('[OpenClaw] Heartbeat monitor started');
}

/**
 * Stop heartbeat monitoring
 */
export function stopHeartbeatMonitor(): void {
  if (openclawHeartbeatTimer) {
    clearInterval(openclawHeartbeatTimer);
    openclawHeartbeatTimer = null;
  }
  for (const [, state] of reconnectStates) {
    if (state.timer) clearTimeout(state.timer);
  }
  reconnectStates.clear();
  console.log('[OpenClaw] Heartbeat monitor stopped');
}

/**
 * Get connection status for a specific account
 */
export async function getConnectionStatus(accountId: number): Promise<ConnectionStatus> {
  const state = reconnectStates.get(accountId);
  if (state) return state.status;

  try {
    const result = await query(
      `SELECT connection_status FROM notification_accounts WHERE id = $1`,
      [accountId]
    );
    if (result.rows.length > 0) {
      return result.rows[0].connection_status || null;
    }
  } catch {
    // ignore
  }
  return null;
}
