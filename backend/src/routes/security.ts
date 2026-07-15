import { Hono } from 'hono';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { getClientIp } from '../utils/client-ip.js';
import { logSecurityEvent } from '../services/security-event.service.js';
import { deleteSessionById, deleteAllUserSessions } from '../services/session.service.js';
import { lookupGeoLabel } from '../utils/geoip.js';
import type { User } from '@timemark/shared';
import { isTurnstileEnabled } from '../utils/turnstile.js';

const security = new Hono<{ Variables: { user: User } }>();
security.use('*', authMiddleware);

// ============ Sessions ============

security.get('/sessions', async (c) => {
  const user = c.get('user');
  const bearer = c.req.header('Authorization')?.replace('Bearer ', '');
  const { verifyToken } = await import('../utils/jwt.js');
  const current = bearer ? await verifyToken(bearer) : null;

  const result = await query(
    `SELECT id, device_fingerprint, is_trusted, expires_at, created_at
     FROM sessions WHERE user_id = $1 AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [parseInt(user.id, 10)],
  );

  const sessions = await Promise.all(
    result.rows.map(async (row: Record<string, unknown>) => {
      const sessionRow = await query('SELECT token FROM sessions WHERE id = $1', [row.id]);
      const token = sessionRow.rows[0]?.token as string | undefined;
      return {
        id: row.id,
        deviceFingerprint: row.device_fingerprint,
        isTrusted: row.is_trusted,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        isCurrent: !!current?.sessionToken && token === current.sessionToken,
      };
    }),
  );

  return c.json({ success: true, data: sessions });
});

security.delete('/sessions/:id', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('id');
  const owned = await query(
    'SELECT id FROM sessions WHERE id = $1 AND user_id = $2',
    [sessionId, parseInt(user.id, 10)],
  );
  if (!owned.rows.length) {
    return c.json({ success: false, error: 'Session not found' }, 404);
  }
  await deleteSessionById(sessionId);
  await logSecurityEvent({
    userId: parseInt(user.id, 10),
    username: user.username,
    eventType: 'session_revoked',
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
    metadata: { sessionId },
  });
  return c.json({ success: true });
});

security.delete('/sessions', async (c) => {
  const user = c.get('user');
  const bearer = c.req.header('Authorization')?.replace('Bearer ', '');
  const { verifyToken } = await import('../utils/jwt.js');
  const current = bearer ? await verifyToken(bearer) : null;
  await deleteAllUserSessions(user.id, current?.sessionToken);
  return c.json({ success: true });
});

// ============ Security events timeline ============

security.get('/events', async (c) => {
  const user = c.get('user');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
  const result = await query(
    `SELECT id, event_type, ip_address, user_agent, metadata, created_at
     FROM security_events
     WHERE user_id = $1 OR username = $2
     ORDER BY created_at DESC LIMIT $3`,
    [parseInt(user.id, 10), user.username, limit],
  );
  return c.json({ success: true, data: result.rows });
});

// ============ IP whitelist ============

security.get('/ip-whitelist', async (c) => {
  const user = c.get('user');
  const result = await query(
    'SELECT ip_whitelist, ip_whitelist_enabled FROM user_configs WHERE user_id = $1',
    [parseInt(user.id, 10)],
  );
  const row = result.rows[0] as { ip_whitelist?: string[]; ip_whitelist_enabled?: boolean } | undefined;
  return c.json({
    success: true,
    data: {
      enabled: !!row?.ip_whitelist_enabled,
      ips: Array.isArray(row?.ip_whitelist) ? row.ip_whitelist : [],
    },
  });
});

security.put('/ip-whitelist', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const enabled = !!body.enabled;
  const ips = Array.isArray(body.ips)
    ? body.ips.map((ip: string) => String(ip).trim()).filter(Boolean).slice(0, 50)
    : [];

  await query(
    `INSERT INTO user_configs (user_id, ip_whitelist, ip_whitelist_enabled)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       ip_whitelist = $2::jsonb,
       ip_whitelist_enabled = $3`,
    [parseInt(user.id, 10), JSON.stringify(ips), enabled],
  );
  return c.json({ success: true, data: { enabled, ips } });
});

// ============ IP ban management ============

security.get('/ip-bans', async (c) => {
  const result = await query(
    `SELECT identifier, failed_count, locked_until, last_attempt
     FROM login_attempts WHERE type = 'ip' AND locked_until > NOW()
     ORDER BY locked_until DESC LIMIT 100`,
  );
  const bans = await Promise.all(
    result.rows.map(async (row: Record<string, unknown>) => ({
      ip: row.identifier,
      failedCount: row.failed_count,
      lockedUntil: row.locked_until,
      lastAttempt: row.last_attempt,
      geo: await lookupGeoLabel(String(row.identifier || '')),
    })),
  );
  return c.json({ success: true, data: bans });
});

security.delete('/ip-bans/:ip', async (c) => {
  const ip = decodeURIComponent(c.req.param('ip'));
  await query(`DELETE FROM login_attempts WHERE identifier = $1 AND type = 'ip'`, [ip]);
  return c.json({ success: true });
});

// ============ TOTP 2FA ============

security.get('/totp/status', async (c) => {
  const user = c.get('user');
  const result = await query(
    'SELECT totp_secret, totp_enabled FROM users WHERE id = $1',
    [parseInt(user.id, 10)],
  );
  const row = result.rows[0] as { totp_secret?: string; totp_enabled?: boolean } | undefined;
  return c.json({ success: true, data: { enabled: !!(row?.totp_enabled && row?.totp_secret) } });
});

security.post('/totp/setup', async (c) => {
  const user = c.get('user');
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(user.username, 'TimeMark', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  await query(
    'UPDATE users SET totp_secret = $1, totp_enabled = FALSE WHERE id = $2',
    [secret, parseInt(user.id, 10)],
  );
  return c.json({ success: true, data: { secret, qrDataUrl, otpauth } });
});

security.post('/totp/enable', async (c) => {
  const user = c.get('user');
  const { code } = await c.req.json().catch(() => ({}));
  const result = await query('SELECT totp_secret FROM users WHERE id = $1', [parseInt(user.id, 10)]);
  const secret = result.rows[0]?.totp_secret as string | undefined;
  if (!secret) return c.json({ success: false, error: '请先初始化 2FA' }, 400);
  if (!authenticator.verify({ token: String(code || ''), secret })) {
    return c.json({ success: false, error: '验证码错误' }, 401);
  }
  await query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [parseInt(user.id, 10)]);
  await logSecurityEvent({
    userId: parseInt(user.id, 10),
    username: user.username,
    eventType: 'totp_enabled',
    ip: getClientIp(c),
  });
  return c.json({ success: true });
});

security.post('/totp/disable', async (c) => {
  const user = c.get('user');
  const { code, password } = await c.req.json().catch(() => ({}));
  const { verifyUserPassword } = await import('../services/auth.service.js');
  const verified = await verifyUserPassword(user.username, String(password || ''));
  if (!verified) return c.json({ success: false, error: '密码错误' }, 401);

  const result = await query('SELECT totp_secret FROM users WHERE id = $1', [parseInt(user.id, 10)]);
  const secret = result.rows[0]?.totp_secret as string | undefined;
  if (secret && !authenticator.verify({ token: String(code || ''), secret })) {
    return c.json({ success: false, error: '验证码错误' }, 401);
  }
  await query('UPDATE users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = $1', [parseInt(user.id, 10)]);
  await logSecurityEvent({
    userId: parseInt(user.id, 10),
    username: user.username,
    eventType: 'totp_disabled',
    ip: getClientIp(c),
  });
  return c.json({ success: true });
});

// ============ Deploy / system info ============

security.get('/deploy-info', async (c) => {
  const jwtAge = process.env.JWT_SECRET_ROTATED_AT || null;
  return c.json({
    success: true,
    data: {
      version: process.env.npm_package_version || '2.7.0',
      platform: process.env.VERCEL ? 'vercel' : 'local',
      vercelUrl: process.env.VERCEL_URL || null,
      turnstileConfigured: isTurnstileEnabled(),
      cronSecretConfigured: !!process.env.CRON_SECRET,
      jwtSecretRotatedAt: jwtAge,
      buildTime: process.env.VERCEL_GIT_COMMIT_SHA || null,
    },
  });
});

export default security;
