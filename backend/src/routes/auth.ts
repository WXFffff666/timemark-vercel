import { Hono } from 'hono';
import { verifyUserPassword, updateTOTPSecret, createLoginLog, trackLoginFailure } from '../services/auth.service.js';
import { createSession, deleteSession, getSessionByToken } from '../services/session.service.js';
import { generateTOTPSecret, generateQRCode, verifyTOTP } from '../utils/totp.js';
import { generateAccessToken, generateRefreshToken, verifyToken } from '../utils/jwt.js';
import { loginSchema, verify2FASchema, changePasswordSchema } from '@timemark/shared';
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

    if (user.totpSecret) {
      const tempToken = await generateAccessToken(user.id, undefined, false);
      return c.json({ success: true, data: { requiresTOTP: true, tempToken } });
    }

    const { accessToken, refreshToken } = await createSession(user.id, deviceFingerprint || '', false, rememberMe);
    return c.json({ success: true, data: { requiresTOTP: false, accessToken, refreshToken, user } });
  } catch (error: any) {
    console.error('[Login Error]', error);
    return c.json({ success: false, error: error.message || 'Login failed' }, 500);
  }
});

auth.post('/verify-2fa', async (c) => {
  const body = await c.req.json();
  const parsed = verify2FASchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid input' }, 400);
  }

  const { tempToken, totpCode, trustDevice, rememberMe = false } = parsed.data;
  const payload = await import('../utils/jwt.js').then(m => m.verifyToken(tempToken));

  if (!payload) {
    return c.json({ success: false, error: 'Invalid token' }, 401);
  }

  const { getUserById } = await import('../services/auth.service.js');
  const user = await getUserById(payload.userId);
  if (!user || !user.totpSecret) {
    return c.json({ success: false, error: 'User not found' }, 401);
  }

  const valid = verifyTOTP(user.totpSecret, totpCode);
  if (!valid) {
    return c.json({ success: false, error: 'Invalid 2FA code' }, 401);
  }

  const { accessToken, refreshToken } = await createSession(user.id, '', false, rememberMe);
  return c.json({ success: true, data: { accessToken, refreshToken, user } });
});

auth.post('/setup-2fa', authMiddleware, async (c) => {
  const user = c.get('user');
  const secret = generateTOTPSecret();
  const qrCode = await generateQRCode(secret, user.username);

  return c.json({ success: true, data: { secret, qrCode } });
});

auth.post('/confirm-2fa', authMiddleware, async (c) => {
  const user = c.get('user');
  const { totpCode, secret } = await c.req.json();

  const valid = verifyTOTP(secret, totpCode);
  if (!valid) {
    return c.json({ success: false, error: 'Invalid code' }, 400);
  }

  await updateTOTPSecret(user.id, secret);
  return c.json({ success: true, data: { message: '2FA enabled' } });
});

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
