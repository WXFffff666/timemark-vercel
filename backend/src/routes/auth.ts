import { Hono } from 'hono';
import { verifyUserPassword, createLoginLog, trackLoginFailure } from '../services/auth.service.js';
import { createSession, deleteSession } from '../services/session.service.js';
import { generateAccessToken, generateRefreshToken, verifyToken } from '../utils/jwt.js';
import { loginSchema, changePasswordSchema } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { sendSecurityAlert } from '../services/alert.service.js';
import { hashPassword } from '../utils/password.js';
import { query } from '../db/index.js';

const auth = new Hono();

auth.post('/login', async (c) => {
  try {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const userAgent = c.req.header('user-agent') || 'unknown';
    
    const body = await c.req.json();
    const parsed = loginSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid input' }, 400);
    }

    const { username, password, deviceFingerprint, rememberMe = false } = parsed.data;
    const user = await verifyUserPassword(username, password);

    if (!user) {
      await createLoginLog(username, ip, userAgent, '', false, 'Invalid credentials');
      const tracking = await trackLoginFailure({ username, ip });
      
      if (tracking.failureCount >= 5) {
        await sendSecurityAlert({
          adminEmails: ['1127251096@qq.com', 'wxf200707@gmail.com'],
          username,
          ip,
          userAgent,
          failureCount: tracking.failureCount,
          locked: tracking.shouldLock
        });
      }
      
      return c.json({ success: false, error: 'Invalid credentials' }, 401);
    }

    await createLoginLog(user.id, ip, userAgent, '', true);

    const { accessToken, refreshToken } = await createSession(user.id, deviceFingerprint || '', false, rememberMe);
    return c.json({ success: true, data: { accessToken, refreshToken, user } });
  } catch (error: any) {
    console.error('[Login Error]', error);
    return c.json({ success: false, error: error.message || 'Login failed' }, 500);
  }
});

// 2FA endpoints removed - not needed for local deployment

auth.post('/verify-device', authMiddleware, async (c) => {
  const user = c.get('user');
  const { deviceFingerprint } = await c.req.json();
  
  if (!deviceFingerprint) {
    return c.json({ success: false, error: 'Missing deviceFingerprint' }, 400);
  }

  const { getSessionByToken } = await import('../services/session.service.js');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const session = await getSessionByToken(token || '');
  
  const trusted = session?.isTrusted && session?.deviceFingerprint === deviceFingerprint;
  return c.json({ success: true, data: { trusted } });
});

auth.post('/logout', authMiddleware, async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (token) {
    deleteSession(token);
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
    const accessToken = await generateAccessToken(user.id, undefined, false);

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
    const result = await query(
      'SELECT id, ip_address, username, user_agent, device_fingerprint, success, failure_reason, login_time FROM login_logs WHERE user_id = $1 ORDER BY login_time DESC LIMIT 50',
      [user.id]
    );
    return c.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Failed to fetch login history:', error);
    return c.json({ success: true, data: [] });
  }
});

auth.delete('/login-history', authMiddleware, async (c) => {
  const user = c.get('user');
  try {
    await query('DELETE FROM login_logs WHERE user_id = $1', [user.id]);
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
