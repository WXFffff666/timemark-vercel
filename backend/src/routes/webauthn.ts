import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { getClientIp } from '../utils/client-ip.js';
import { logSecurityEvent } from '../services/security-event.service.js';
import { getWebAuthnConfig } from '../utils/webauthn-config.js';
import {
  listUserPasskeys,
  createRegistrationOptions,
  verifyRegistration,
  deletePasskey,
} from '../services/webauthn.service.js';
import type { User } from '@timemark/shared';

const webauthn = new Hono<{ Variables: { user: User } }>();

const registerOptionsSchema = z.object({
  deviceName: z.string().max(64).optional(),
});

const registerVerifySchema = z.object({
  response: z.record(z.unknown()),
  deviceName: z.string().max(64).optional(),
});

// ============ Authenticated: Passkey management (not used for login) ============

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
