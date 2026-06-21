import axios from 'axios';
import QRCode from 'qrcode';
import { getBlessing } from '../../../../shared/src/blessings.js';
import { query } from '../../db/index.js';
import { encrypt, decrypt } from '@timemark/shared/crypto';

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';

// Session timeout: 5 minutes
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
// Cleanup interval: every 60 seconds
const CLEANUP_INTERVAL_MS = 60 * 1000;

// Store active sessions by session ID (in-memory cache for fast polling)
interface ClawBotSession {
  sessionId: string;
  qrcode: string; // raw qrcode value for polling
  bot_token?: string;
  ilink_bot_id?: string;
  baseUrl?: string;
  authenticated: boolean;
  user?: string;
  createdAt: number;
}

const activeSessions = new Map<string, ClawBotSession>();

function getMasterKey(): string {
  return process.env.MASTER_KEY || 'timemark-default-master-key-change-in-production-2026';
}

/**
 * Persist session to SQLite database
 */
async function persistSession(session: ClawBotSession): Promise<void> {
  const expiresAt = new Date(session.createdAt + SESSION_TIMEOUT_MS).toISOString();
  const status = session.authenticated ? 'authenticated' : 'pending';
  const sessionData = encrypt(JSON.stringify(session), getMasterKey());

  await query(
    `INSERT INTO plugin_sessions (channel_type, session_id, session_data, status, expires_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    ['clawbot', session.sessionId, sessionData, status, expiresAt]
  );
}

/**
 * Load session from SQLite database into cache
 */
async function loadSessionFromDb(sessionId: string): Promise<ClawBotSession | null> {
  const result = await query(
    `SELECT session_data, status FROM plugin_sessions WHERE session_id = $1 AND expires_at > NOW()`,
    [sessionId]
  );
  if (result.rows.length === 0) return null;

  try {
    const decrypted = decrypt(result.rows[0].session_data, getMasterKey());
    const session: ClawBotSession = JSON.parse(decrypted);
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

/**
 * Periodic cleanup of expired sessions
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of activeSessions) {
    if (!session.authenticated && now - session.createdAt > SESSION_TIMEOUT_MS) {
      activeSessions.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[ClawBot] 清理了 ${cleaned} 个过期会话，剩余 ${activeSessions.size} 个活跃会话`);
  }
}

// Start periodic cleanup
setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);

/**
 * Normalize iLink API status response to a known state string.
 * The API may return status as a string ('confirmed', 'expired', 'scaned', 'wait')
 * or as a numeric code (1=confirmed, 2=expired, 3=scanned, 0=waiting).
 */
function normalizeStatus(rawStatus: unknown): 'confirmed' | 'expired' | 'scanned' | 'waiting' | 'unknown' {
  // Handle numeric status codes
  if (typeof rawStatus === 'number') {
    switch (rawStatus) {
      case 1: return 'confirmed';
      case 2: return 'expired';
      case 3: return 'scanned';
      case 0: return 'waiting';
      default: return 'unknown';
    }
  }

  // Handle string status values (case-insensitive)
  if (typeof rawStatus === 'string') {
    const lower = rawStatus.toLowerCase().trim();
    if (lower === 'confirmed' || lower === 'success' || lower === 'authenticated') return 'confirmed';
    if (lower === 'expired' || lower === 'timeout') return 'expired';
    if (lower === 'scanned' || lower === 'scaned') return 'scanned';
    if (lower === 'wait' || lower === 'waiting' || lower === 'pending') return 'waiting';
    return 'unknown';
  }

  return 'unknown';
}

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
    throw new Error('无法从 iLink API 获取二维码，请稍后重试');
  }

  // Convert the qrcode URL to a data URL image
  const qrDataUrl = await QRCode.toDataURL(data.qrcode, {
    type: 'image/png',
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });

  const session: ClawBotSession = {
    sessionId,
    qrcode: data.qrcode,
    authenticated: false,
    createdAt: Date.now(),
  };

  activeSessions.set(sessionId, session);
  await persistSession(session);

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

    const session = activeSessions.get(parsed.sessionId) || await loadSessionFromDb(parsed.sessionId) || null;
    if (!session) {
      // Session not in memory or DB — check if sessionData already has credentials
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

    // Check session timeout (5 minutes)
    if (Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
      await deleteSession(parsed.sessionId);
      console.log(`[ClawBot] 会话 ${parsed.sessionId} 已超时（5分钟），自动清理`);
      return { authenticated: false };
    }

    // Poll the qrcode status
    const { data } = await axios.get(`${ILINK_BASE}/ilink/bot/get_qrcode_status`, {
      params: { qrcode: session.qrcode },
      timeout: 10000,
    });

    // Log raw response for debugging
    console.log('[ClawBot] Raw status response:', JSON.stringify(data));

    if (!data) {
      console.log('[ClawBot] 状态查询返回空响应');
      return { authenticated: false };
    }

    // Extract status - handle both data.status and data directly being a status code
    const rawStatus = data.status !== undefined ? data.status : data;
    const status = normalizeStatus(rawStatus);

    console.log(`[ClawBot] 会话 ${parsed.sessionId} 状态: ${status} (原始值: ${JSON.stringify(rawStatus)})`);

    switch (status) {
      case 'confirmed': {
        // Extract bot_token from response - may be at different paths
        const botToken = data.bot_token || data.botToken || data.token;
        if (!botToken) {
          console.log('[ClawBot] 认证已确认但未收到 bot_token，等待下次轮询');
          return { authenticated: false };
        }

        session.bot_token = botToken;
        session.ilink_bot_id = data.ilink_bot_id || data.botId || '';
        session.baseUrl = data.baseurl || data.baseUrl || ILINK_BASE;
        session.authenticated = true;
        session.user = data.ilink_bot_id || data.botId || 'ClawBot';
        activeSessions.set(parsed.sessionId, session);
        await persistSession(session);

        console.log(`[ClawBot] 会话 ${parsed.sessionId} 认证成功，用户: ${session.user}`);
        return { authenticated: true, user: session.user, sessionData: exportSessionData(session.sessionId) || undefined };
      }

      case 'expired': {
        await deleteSession(parsed.sessionId);
        console.log(`[ClawBot] 会话 ${parsed.sessionId} 二维码已过期`);
        return { authenticated: false };
      }

      case 'scanned': {
        console.log(`[ClawBot] 会话 ${parsed.sessionId} 二维码已扫描，等待用户确认`);
        return { authenticated: false };
      }

      case 'waiting': {
        return { authenticated: false };
      }

      case 'unknown':
      default: {
        // Log unknown status for investigation but don't crash
        console.warn(`[ClawBot] 会话 ${parsed.sessionId} 收到未知状态: ${JSON.stringify(rawStatus)}，类型: ${typeof rawStatus}`);
        return { authenticated: false };
      }
    }
  } catch (error: any) {
    const message = error?.message || String(error);
    console.error(`[ClawBot] 检查认证状态出错: ${message}`);
    if (error?.response?.data) {
      console.error('[ClawBot] API 错误响应:', JSON.stringify(error.response.data));
    }
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

    await deleteSession(parsed.sessionId);
    console.log(`[ClawBot] 会话 ${parsed.sessionId} 已登出并清理`);
  } catch (error: any) {
    console.error(`[ClawBot] 登出时出错: ${error?.message || error}`);
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

// ============================================================================
// Connection Status & Auto-Reconnect
// ============================================================================

type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting' | null;

// Track reconnect state per account
interface ReconnectState {
  retryCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  status: ConnectionStatus;
}

const reconnectStates = new Map<number, ReconnectState>();

// Backoff schedule: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 300s
const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000];
const MAX_RETRIES = 10;

// Heartbeat interval: 60 seconds
const HEARTBEAT_INTERVAL_MS = 60_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Update connection_status in the database for a notification account
 */
async function updateConnectionStatus(accountId: number, status: ConnectionStatus): Promise<void> {
  try {
    await query(
      `UPDATE notification_accounts SET connection_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [status, accountId]
    );
  } catch (error) {
    console.error(`[ClawBot] Failed to update connection_status for account ${accountId}:`, error);
  }
}

/**
 * Check if a bot_token is still valid by making a lightweight API call
 */
async function checkConnection(token: string, baseUrl: string = ILINK_BASE): Promise<boolean> {
  try {
    const { data } = await axios.get(`${baseUrl}/ilink/bot/get_bot_info`, {
      headers: {
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': `Bearer ${token}`,
      },
      timeout: 10000,
    });
    // If we get a response without error, the token is valid
    return !!(data && !data.error);
  } catch {
    return false;
  }
}

/**
 * Attempt to reconnect a disconnected ClawBot account
 * Uses the saved session_data to re-verify the token
 */
async function attemptReconnect(accountId: number, token: string, baseUrl: string): Promise<boolean> {
  const isValid = await checkConnection(token, baseUrl);
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
    console.log(`[ClawBot] Account ${accountId} reconnected successfully`);
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
    console.warn(`[ClawBot] Account ${accountId} exceeded max retries (${MAX_RETRIES}), giving up`);
    state.status = 'disconnected';
    updateConnectionStatus(accountId, 'disconnected');
    reconnectStates.delete(accountId);
    return;
  }

  const delay = BACKOFF_DELAYS[Math.min(state.retryCount, BACKOFF_DELAYS.length - 1)];
  state.retryCount++;
  state.status = 'reconnecting';
  updateConnectionStatus(accountId, 'reconnecting');

  console.log(`[ClawBot] Account ${accountId} reconnect attempt ${state.retryCount}/${MAX_RETRIES} in ${delay}ms`);

  state.timer = setTimeout(async () => {
    const success = await attemptReconnect(accountId, token, baseUrl);
    if (!success) {
      scheduleReconnect(accountId, token, baseUrl);
    }
  }, delay);
}

/**
 * Run heartbeat check for all active ClawBot accounts
 * Queries notification_accounts with type='clawbot' and config_method='plugin'
 */
async function runHeartbeat(): Promise<void> {
  try {
    const result = await query(
      `SELECT id, token, session_data, connection_status FROM notification_accounts WHERE type = 'clawbot' AND config_method = 'plugin' AND is_active = TRUE`,
      []
    );

    for (const row of result.rows) {
      // Skip accounts already in reconnect cycle
      if (reconnectStates.has(row.id)) continue;

      let token: string | null = null;
      let baseUrl = ILINK_BASE;

      // Try to extract token from session_data
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
          token = sessionData.bot_token || null;
          baseUrl = sessionData.baseUrl || ILINK_BASE;
        } catch {
          // Can't parse session data
        }
      }

      // Fallback to token column
      if (!token && row.token) {
        try {
          const masterKey = process.env.MASTER_KEY || 'timemark-default-master-key-change-in-production-2026';
          token = decrypt(row.token, masterKey);
        } catch {
          token = row.token;
        }
      }

      if (!token) continue;

      const isConnected = await checkConnection(token, baseUrl);

      if (isConnected) {
        if (row.connection_status !== 'connected') {
          await updateConnectionStatus(row.id, 'connected');
        }
      } else {
        console.warn(`[ClawBot] Account ${row.id} connection lost, starting reconnect`);
        await updateConnectionStatus(row.id, 'disconnected');
        scheduleReconnect(row.id, token, baseUrl);
      }
    }
  } catch (error) {
    console.error('[ClawBot] Heartbeat check failed:', error);
  }
}

/**
 * Start periodic heartbeat monitoring for ClawBot accounts
 */
export function startHeartbeatMonitor(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);
  // Run first check after a short delay to let the app start up
  setTimeout(runHeartbeat, 5000);
  console.log('[ClawBot] Heartbeat monitor started');
}

/**
 * Stop heartbeat monitoring
 */
export function stopHeartbeatMonitor(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  // Clear all reconnect timers
  for (const [, state] of reconnectStates) {
    if (state.timer) clearTimeout(state.timer);
  }
  reconnectStates.clear();
  console.log('[ClawBot] Heartbeat monitor stopped');
}

/**
 * Get connection status for a specific account
 */
export async function getConnectionStatus(accountId: number): Promise<ConnectionStatus> {
  // Check in-memory reconnect state first
  const state = reconnectStates.get(accountId);
  if (state) return state.status;

  // Fall back to DB
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
