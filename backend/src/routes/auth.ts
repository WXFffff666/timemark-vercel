import { Hono } from 'hono';
import { verifyUserPassword, getUserByUsername, createLoginLog, trackLoginFailure, getAccountLockStatus, clearAccountLock, getIpBlockStatus, evaluateIpBlock } from '../services/auth.service.js';
import { getClientIp } from '../utils/client-ip.js';
import { createSession, deleteSession, deleteSessionById, deleteAllUserSessions } from '../services/session.service.js';
import { generateAccessToken, generateRefreshToken, verifyToken } from '../utils/jwt.js';
import { loginSchema, changePasswordSchema } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { sendSecurityAlert } from '../services/alert.service.js';
import { ensureLunarHolidayEvents } from '../services/lunar-holidays.js';
import { hashPassword } from '../utils/password.js';
import { query } from '../db/index.js';

const auth = new Hono();

auth.post('/login', async (c) => {
  try {
    const ip = getClientIp(c);
    const userAgent = c.req.header('user-agent') || 'unknown';

    const body = await c.req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid input' }, 400);
    }

    const { username, password, deviceFingerprint, rememberMe = false } = parsed.data;

    const ipBlock = await getIpBlockStatus(ip);
    if (ipBlock.isBlocked) {
      return c.json({
        success: false,
        error: `该 IP 已被临时封禁，剩余 ${ipBlock.remainingSeconds} 秒`,
        locked: true,
        remainingSeconds: ipBlock.remainingSeconds,
      }, 429);
    }

    const lockStatus = await getAccountLockStatus({ username, ip });
    if (lockStatus.isLocked) {
      return c.json({
        success: false,
        error: `账户已锁定，剩余 ${lockStatus.remainingSeconds} 秒后可重试`,
        locked: true,
        remainingSeconds: lockStatus.remainingSeconds,
        lockMinutes: lockStatus.lockMinutes,
      }, 429);
    }

    const user = await verifyUserPassword(username, password);

    if (!user) {
      await createLoginLog(username, ip, userAgent, deviceFingerprint || '', false, 'Invalid credentials');
      await evaluateIpBlock(ip);

      const tracking = await trackLoginFailure({ username, ip });

      if (tracking.shouldLock) {
        const targetUser = await getUserByUsername(username);
        const userId = targetUser ? parseInt(targetUser.id, 10) : undefined;

        await sendSecurityAlert({
          userId,
          adminEmails: [],
          username,
          ip,
          userAgent,
          failureCount: tracking.failureCount,
          locked: true,
          lockMinutes: tracking.lockMinutes,
          alertType: 'login_failure',
        });

        const newLockStatus = await getAccountLockStatus({ username, ip });
        return c.json({
          success: false,
          error: `登录失败次数过多，账户已锁定 ${tracking.lockMinutes} 分钟（剩余 ${newLockStatus.remainingSeconds} 秒）`,
          locked: true,
          remainingSeconds: newLockStatus.remainingSeconds,
          lockMinutes: tracking.lockMinutes,
        }, 429);
      }

      const remaining = 5 - (tracking.failureCount % 5);
      return c.json({ success: false, error: `密码错误，还剩 ${remaining} 次尝试机会` }, 401);
    }

    await createLoginLog(user.id, ip, userAgent, deviceFingerprint || '', true);
    await clearAccountLock(username);
    const { session, accessToken, refreshToken } = await createSession(user.id, deviceFingerprint || '', false, rememberMe);

    const pwdCheck = await query(
      'SELECT password_changed_at FROM user_configs WHERE user_id = $1',
      [user.id],
    );
    const mustChangePassword = !pwdCheck.rows[0]?.password_changed_at;

    // Auto-sync lunar holidays in background (non-blocking)
    ensureLunarHolidayEvents(Number(user.id)).catch(() => {});

    return c.json({
      success: true,
      data: { accessToken, refreshToken, sessionId: session.id, user, mustChangePassword },
    });
  } catch (error: any) {
    console.error('[Login Error]', error);
    return c.json({ success: false, error: error.message || 'Login failed' }, 500);
  }
});

// 2FA endpoints removed - not needed for local deployment

auth.post('/verify-device', authMiddleware, async (c) => {
  const { deviceFingerprint } = await c.req.json();
  
  if (!deviceFingerprint) {
    return c.json({ success: false, error: 'Missing deviceFingerprint' }, 400);
  }

  const bearer = c.req.header('Authorization')?.replace('Bearer ', '');
  const payload = bearer ? await verifyToken(bearer) : null;
  if (!payload?.sessionToken) {
    return c.json({ success: true, data: { trusted: false } });
  }

  const { getSessionByToken } = await import('../services/session.service.js');
  const session = await getSessionByToken(payload.sessionToken);
  
  const trusted = session?.isTrusted && session?.deviceFingerprint === deviceFingerprint;
  return c.json({ success: true, data: { trusted } });
});

auth.post('/logout', authMiddleware, async (c) => {
  const bearer = c.req.header('Authorization')?.replace('Bearer ', '');
  const body = await c.req.json().catch(() => ({}));
  const sessionId = body?.sessionId as string | undefined;

  if (sessionId) {
    await deleteSessionById(sessionId);
  } else if (bearer) {
    const payload = await verifyToken(bearer);
    if (payload?.sessionToken) {
      await deleteSession(payload.sessionToken);
    }
  }
  return c.json({ success: true });
});

auth.post('/change-password', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    const parsed = changePasswordSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid input', details: parsed.error }, 400);
    }

    const { currentPassword, newPassword } = parsed.data;

    // Verify current password
    const userWithPassword = await verifyUserPassword(user.username, currentPassword);
    if (!userWithPassword) {
      return c.json({ success: false, error: 'Current password is incorrect' }, 401);
    }

    // Validate new password strength
    if (newPassword.length < 8) {
      return c.json({ success: false, error: 'New password must be at least 8 characters' }, 400);
    }

    // Hash new password and update
    const newPasswordHash = await hashPassword(newPassword);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newPasswordHash, user.id]);
    await query(
      `INSERT INTO user_configs (user_id, password_changed_at)
       VALUES ($1, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET password_changed_at = CURRENT_TIMESTAMP`,
      [user.id],
    );

    const bearer = c.req.header('Authorization')?.replace('Bearer ', '');
    const currentPayload = bearer ? await verifyToken(bearer) : null;
    await deleteAllUserSessions(user.id, currentPayload?.sessionToken);

    await sendSecurityAlert({
      userId: Number(user.id),
      adminEmails: [],
      username: user.username,
      ip: getClientIp(c),
      userAgent: c.req.header('user-agent') || 'unknown',
      failureCount: 0,
      locked: false,
      alertType: 'password_change',
    });

    return c.json({ success: true, message: 'Password changed successfully' });
  } catch (error: any) {
    console.error('[Change Password Error]', error);
    return c.json({ success: false, error: error.message || 'Failed to change password' }, 500);
  }
});

auth.post('/refresh', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { refreshToken } = body;

    if (!refreshToken) {
      return c.json({ success: false, error: 'Refresh token is required' }, 400);
    }

    // Verify refresh token
    const payload = await verifyToken(refreshToken);
    if (!payload) {
      return c.json({ success: false, error: 'Invalid or expired refresh token' }, 401);
    }

    // Get user and create new access token
    const { getUserById } = await import('../services/auth.service.js');
    const user = await getUserById(payload.userId);
    
    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 401);
    }

    // Generate new access token
    const accessToken = await generateAccessToken(user.id, payload.sessionToken, false);

    return c.json({ success: true, data: { accessToken, user } });
  } catch (error: any) {
    console.error('[Refresh Token Error]', error);
    return c.json({ success: false, error: error.message || 'Failed to refresh token' }, 500);
  }
});

export default auth;

// ============ Session endpoint for checking auth status ============

auth.get('/session', authMiddleware, async (c) => {
  const user = c.get('user');
  return c.json({ success: true, data: user });
});

// ============ Login history endpoints ============

function toIsoLoginTime(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  if (s.includes('T') || s.endsWith('Z')) return new Date(s).toISOString();
  return new Date(`${s}Z`).toISOString();
}

auth.get('/login-history', authMiddleware, async (c) => {
  const user = c.get('user');
  try {
    const numericUserId = parseInt(user.id, 10);

    const result = await query(
      `SELECT id, ip_address, username, user_agent, device_fingerprint, success, failure_reason, login_time
       FROM login_logs
       WHERE user_id = $1 OR (user_id IS NULL AND username = $2)
       ORDER BY login_time DESC LIMIT 100`,
      [numericUserId, user.username],
    );

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      ...row,
      success: row.success === true || row.success === 't',
      login_time: toIsoLoginTime(row.login_time),
    }));

    return c.json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch login history:', error);
    return c.json({ success: false, error: 'Failed to fetch login history' }, 500);
  }
});

auth.delete('/login-history', authMiddleware, async (c) => {
  const user = c.get('user');
  try {
    const numericUserId = parseInt(user.id, 10);
    await query(
      'DELETE FROM login_logs WHERE user_id = $1 OR (user_id IS NULL AND username = $2)',
      [numericUserId, user.username],
    );
    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to clear login history:', error);
    return c.json({ success: false, error: 'Failed to clear logs' }, 500);
  }
});

// ============ Avatar upload endpoint ============

auth.post('/avatar', authMiddleware, async (c) => {
  const user = c.get('user');
  try {
    const body = await c.req.json();
    const { avatarUrl } = body;
    
    if (!avatarUrl) {
      return c.json({ success: false, error: 'avatarUrl is required' }, 400);
    }
    
    // Validate URL format
    try {
      new URL(avatarUrl);
    } catch {
      return c.json({ success: false, error: 'Invalid avatar URL format' }, 400);
    }
    
    const numericId = parseInt(user.id, 10);
    if (isNaN(numericId)) {
      return c.json({ success: false, error: 'Invalid user ID' }, 400);
    }
    
    await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, numericId]);
    
    return c.json({ success: true, data: { avatarUrl } });
  } catch (error: any) {
    console.error('[Update Avatar Error]', error);
    return c.json({ success: false, error: error.message || 'Failed to update avatar' }, 500);
  }
});
