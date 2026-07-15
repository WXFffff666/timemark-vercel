import { Hono } from 'hono';
import { z } from 'zod';
import {
  getUserByUsername,
  createLoginLog,
  clearAccountLock,
  checkIpWhitelist,
} from '../services/auth.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { getClientIp } from '../utils/client-ip.js';
import { verifyTurnstileToken } from '../utils/turnstile.js';
import { logSecurityEvent } from '../services/security-event.service.js';
import { createSession } from '../services/session.service.js';
import { setAuthCookies } from '../utils/auth-cookies.js';
import { getWebAuthnConfig } from '../utils/webauthn-config.js';
import { ensureLunarHolidayEvents } from '../services/lunar-holidays.js';
import { query } from '../db/index.js';
import {
  listUserPasskeys,
  createRegistrationOptions,
  verifyRegistration,
  createAuthenticationOptions,
  verifyAuthentication,
  deletePasskey,
  userHasPasskeys,
} from '../services/webauthn.service.js';
import type { User } from '@timemark/shared';

const webauthn = new Hono<{ Variables: { user: User } }>();

const usernameSchema = z.object({
  username: z.string().min(3).max(64),
});

const registerOptionsSchema = z.object({
  deviceName: z.string().max(64).optional(),
});

const registerVerifySchema = z.object({
  response: z.record(z.unknown()),
  deviceName: z.string().max(64).optional(),
});

const loginVerifySchema = z.object({
  username: z.string().min(3).max(64),
  response: z.record(z.unknown()),
  deviceFingerprint: z.string().optional(),
  rememberMe: z.boolean().optional(),
  turnstileToken: z.string().optional(),
});

// ============ Public: Passkey login ============

webauthn.post('/login/options', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = usernameSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid username' }, 400);
  }

  const user = await getUserByUsername(parsed.data.username);
  if (!user) {
    return c.json({ success: false, error: '用户不存在或未注册 Passkey' }, 404);
  }

  const hasKeys = await userHasPasskeys(parseInt(user.id, 10));
  if (!hasKeys) {
    return c.json({ success: false, error: '该账户尚未注册 Passkey' }, 404);
  }

  try {
    const config = getWebAuthnConfig(c);
    const options = await createAuthenticationOptions(parseInt(user.id, 10), config);
    return c.json({ success: true, data: options });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '无法生成登录选项';
    return c.json({ success: false, error: message }, 400);
  }
});

webauthn.post('/login/verify', async (c) => {
  try {
    const ip = getClientIp(c);
    const userAgent = c.req.header('user-agent') || 'unknown';
    const body = await c.req.json();
    const parsed = loginVerifySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid input' }, 400);
    }

    const { username, response, deviceFingerprint, rememberMe = false, turnstileToken } = parsed.data;

    const turnstile = await verifyTurnstileToken(turnstileToken, ip);
    if (!turnstile.ok) {
      return c.json({ success: false, error: turnstile.error || '人机验证失败' }, 400);
    }

    const user = await getUserByUsername(username);
    if (!user) {
      return c.json({ success: false, error: '用户不存在' }, 401);
    }

    const whitelist = await checkIpWhitelist(user.id, ip);
    if (!whitelist.allowed) {
      return c.json({ success: false, error: whitelist.reason || '当前 IP 不在白名单' }, 403);
    }

    const config = getWebAuthnConfig(c);
    const result = await verifyAuthentication(
      parseInt(user.id, 10),
      response as any,
      config,
    );

    if (!result.verified) {
      await createLoginLog(username, ip, userAgent, deviceFingerprint || '', false, 'Passkey 验证失败');
      await logSecurityEvent({ username, eventType: 'passkey_login_failure', ip, userAgent });
      return c.json({ success: false, error: result.error || 'Passkey 登录失败' }, 401);
    }

    await createLoginLog(user.id, ip, userAgent, deviceFingerprint || '', true);
    await clearAccountLock(username);
    await logSecurityEvent({
      userId: parseInt(user.id, 10),
      username: user.username,
      eventType: 'passkey_login_success',
      ip,
      userAgent,
    });

    const { session, accessToken, refreshToken } = await createSession(
      user.id,
      deviceFingerprint || 'passkey',
      true,
      rememberMe,
    );
    setAuthCookies(c, accessToken, refreshToken, rememberMe);

    const pwdCheck = await query(
      'SELECT password_changed_at FROM user_configs WHERE user_id = $1',
      [user.id],
    );
    const mustChangePassword = !pwdCheck.rows[0]?.password_changed_at;

    ensureLunarHolidayEvents(Number(user.id)).catch(() => {});

    return c.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        sessionId: session.id,
        user,
        mustChangePassword,
        authMode: 'cookie',
      },
    });
  } catch (error: unknown) {
    console.error('[WebAuthn Login Error]', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Passkey 登录失败' }, 500);
  }
});

// ============ Authenticated: Passkey management ============

webauthn.use('/credentials', authMiddleware);
webauthn.use('/credentials/*', authMiddleware);
webauthn.use('/register/*', authMiddleware);

webauthn.get('/credentials', async (c) => {
  const user = c.get('user');
  const credentials = await listUserPasskeys(parseInt(user.id, 10));
  return c.json({ success: true, data: credentials });
});

webauthn.delete('/credentials/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const ok = await deletePasskey(parseInt(user.id, 10), id);
  if (!ok) {
    return c.json({ success: false, error: 'Passkey 不存在' }, 404);
  }
  await logSecurityEvent({
    userId: parseInt(user.id, 10),
    username: user.username,
    eventType: 'passkey_removed',
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent') || 'unknown',
  });
  return c.json({ success: true });
});

webauthn.post('/register/options', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = registerOptionsSchema.safeParse(body);

  const config = getWebAuthnConfig(c);
  const options = await createRegistrationOptions(
    parseInt(user.id, 10),
    user.username,
    config,
    parsed.success ? parsed.data.deviceName : undefined,
  );

  return c.json({ success: true, data: options });
});

webauthn.post('/register/verify', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = registerVerifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid input' }, 400);
  }

  const config = getWebAuthnConfig(c);
  const result = await verifyRegistration(
    parseInt(user.id, 10),
    parsed.data.response as any,
    config,
    parsed.data.deviceName,
  );

  if (!result.verified) {
    return c.json({ success: false, error: result.error || '注册失败' }, 400);
  }

  await logSecurityEvent({
    userId: parseInt(user.id, 10),
    username: user.username,
    eventType: 'passkey_registered',
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent') || 'unknown',
  });

  return c.json({ success: true, message: 'Passkey 注册成功' });
});

webauthn.get('/supported', (c) => {
  const config = getWebAuthnConfig(c);
  return c.json({
    success: true,
    data: {
      rpID: config.rpID,
      origin: config.origin,
      supported: true,
    },
  });
});

export default webauthn;
