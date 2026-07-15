import { Context, Next } from 'hono';
import { verifyToken } from '../utils/jwt.js';
import { getUserById } from '../services/auth.service.js';
import { getSessionByToken } from '../services/session.service.js';
import { getAccessTokenFromCookie } from '../utils/auth-cookies.js';
import type { User } from '@timemark/shared';

export async function authMiddleware(c: Context<{ Variables: { user: User } }>, next: Next) {
  const existingUser = c.get('user');
  if (existingUser) {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '') || getAccessTokenFromCookie(c);

  if (!token) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const payload = await verifyToken(token);

  if (!payload) {
    return c.json({ success: false, error: 'Invalid token' }, 401);
  }

  if (payload.sessionToken) {
    const session = await getSessionByToken(payload.sessionToken);
    if (!session) {
      return c.json({ success: false, error: 'Session expired or revoked' }, 401);
    }
  }

  const user = await getUserById(payload.userId);

  if (!user) {
    return c.json({ success: false, error: 'User not found' }, 401);
  }

  c.set('user', user);
  await next();
}
