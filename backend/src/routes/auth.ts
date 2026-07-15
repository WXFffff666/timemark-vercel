import { Hono } from 'hono';
import { verifyUserPassword, getUserByUsername, createLoginLog, trackLoginFailure, getAccountLockStatus, clearAccountLock } from '../services/auth.service.js';
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
    // 获取真实IP - 优先从代理头获取，其次从连接获取
    // 检查所有可能的代理头
    const forwardedFor = c.req.header('x-forwarded-for');
    const cfIP = c.req.header('cf-connecting-ip');
    const realIP = c.req.header('X-Real-IP');
    const clientIP = c.req.header('Client-IP');
    const forwarded = c.req.header('forwarded');
    
    let ip = '';
    
    // 1. 首先尝试从代理头解析
    if (forwardedFor) {
      // x-forwarded-for 可能包含多个IP，取第一个（最原始的客户端IP）
      ip = forwardedFor.split(',')[0].trim();
    } else if (cfIP) {
      ip = cfIP.trim();
    } else if (realIP) {
      ip = realIP.trim();
    } else if (clientIP) {
      ip = clientIP.trim();
    } else if (forwarded) {
      // forwarded 头格式: for=1.2.3.4, for=5.6.7.8
      const forMatch = forwarded.match(/for=([^,]+)/i);
      ip = forMatch ? forMatch[1].trim() : '';
    }
    
    // 2. 如果没有代理头，尝试从Hono 4.x获取request IP
    if (!ip) {
      try {
        // Hono 4.x 使用 getRequestIP - 但需要传入 options
        // @ts-ignore - hono 4.x 新 API
        if (typeof (c as any).getRequestIP === 'function') {
          // @ts-ignore
          ip = (c as any).getRequestIP({ proxyProof: false }) || '';
        }
      } catch (e) {
        // 忽略错误
      }
    }
    
    // 3. 最后fallback: 从底层socket获取
    if (!ip) {
      try {
        // Node.js request 对象
        const raw = (c.req as any).raw;
        if (raw?.socket?.remoteAddress) {
          ip = raw.socket.remoteAddress.replace(/^::ffff:/, '');
        } else if (raw?.connection?.remoteAddress) {
          ip = raw.connection.remoteAddress.replace(/^::ffff:/, '');
        }
      } catch (e) {
        // 忽略错误
      }
    }
    
    // 4. 最后的fallback - 尝试从req.info获取（hono内部）
    if (!ip) {
      try {
        // @ts-ignore - hono internal
        const req = c.req as any;
        if (req?.raw?.socket?.remoteAddress) {
          ip = req.raw.socket.remoteAddress.replace(/^::ffff:/, '');
        }
      } catch (e) {
        // 忽略
      }
    }
    
    // 5. 如果仍然没有IP，尝试从 event.fetchAPI 获取（Server-Sent Events）
    if (!ip) {
      try {
        // @ts-ignore - hono request event
        const event = (c as any).executionCtx ?? (c as any).req?.raw;
        if (event?.request?.headers) {
          // 检查event.request.headers中的remote地址
        }
      } catch (e) {
        // 忽略
      }
    }
    
    // 6. 对于本地开发环境，使用Docker网络网关IP或localhost
    // Docker容器默认网关通常是172.17.0.1或192.168.65.1
    if (!ip || ip.includes('::') || ip.length > 45) {
      // 尝试获取实际的远端地址
      try {
        // @ts-ignore
        const socket = (c as any).req?.raw?.socket;
        if (socket?.remoteAddress) {
          ip = socket.remoteAddress;
          // 处理IPv6格式
          if (ip.startsWith('::ffff:')) {
            ip = ip.replace('::ffff:', '');
          }
          // 如果是IPv6本地地址，转换为IPv4本地地址
          if (ip === '::1' || ip.startsWith('fe80') || ip.startsWith('::')) {
            ip = '127.0.0.1';
          }
        }
      } catch (e) {
        ip = '127.0.0.1';
      }
    }
    
    // 7. 最终清理：确保返回有效的IPv4地址
    // 清理IPv6前缀和其他无效值
    if (ip) {
      // 移除IPv6映射的IPv4前缀 ::ffff:
      if (ip.startsWith('::ffff:')) {
        ip = ip.replace('::ffff:', '');
      }
      // 如果仍然包含冒号（IPv6），说明是纯IPv6地址
      if (ip.includes(':') && !ip.includes('.')) {
        ip = '';
      }
    }
    
    // 验证并最终设置
    const validIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ip || !validIPv4.test(ip) || ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
      // 对于本地/内网访问，都使用有意义的外网IP
      // 在Docker容器中访问，使用172.17.0.1作为默认网关IP
      ip = ip && validIPv4.test(ip) && !ip.startsWith('127.') ? ip : '127.0.0.1';
    }
    
    console.log('[Auth] Client IP detected:', ip, 'headers:', {
      'x-forwarded-for': forwardedFor,
      'cf-connecting-ip': cfIP,
      'X-Real-IP': realIP,
      'forwarded': forwarded
    });
    
    const userAgent = c.req.header('user-agent') || 'unknown';
    
    const body = await c.req.json();
    const parsed = loginSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid input' }, 400);
    }

    const { username, password, deviceFingerprint, rememberMe = false } = parsed.data;

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

auth.get('/login-history', authMiddleware, async (c) => {
  const user = c.get('user');
  try {
    // 将 user.id 转换为整数，因为数据库中 user_id 是 integer 类型
    const numericUserId = parseInt(user.id, 10);
    
    const result = await query(
      `SELECT id, ip_address, username, user_agent, device_fingerprint, success, failure_reason, login_time
       FROM login_logs 
       WHERE user_id = $1 OR (user_id IS NULL AND username = $2)
       ORDER BY login_time DESC LIMIT 50`,
      [numericUserId, user.username]
    );
    
    // SQLite datetime('now') stores UTC time. Convert to proper ISO 8601 so frontend
    // can correctly interpret the timezone and display local time.
    const rows = result.rows.map((row: any) => ({
      ...row,
      login_time: row.login_time ? new Date(row.login_time + 'Z').toISOString() : row.login_time
    }));
    
    return c.json({ success: true, data: rows });
  } catch (error) {
    console.error('Failed to fetch login history:', error);
    return c.json({ success: true, data: [] });
  }
});

auth.delete('/login-history', authMiddleware, async (c) => {
  const user = c.get('user');
  try {
    await query('DELETE FROM login_logs WHERE user_id = $1', [parseInt(user.id, 10)]);
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
