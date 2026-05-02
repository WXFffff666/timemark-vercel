import { Context, Next } from 'hono';
import { verifyToken } from '../utils/jwt.js';
import { getUserById } from '../services/auth.service.js';
import type { User } from '@timemark/shared';

export async function authMiddleware(c: Context<{ Variables: { user: User } }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const payload = await verifyToken(token);
  
  if (!payload) {
    return c.json({ success: false, error: 'Invalid token' }, 401);
  }

  const user = await getUserById(payload.userId);

  if (!user) {
    return c.json({ success: false, error: 'User not found' }, 401);
  }

  c.set('user', user);
  await next();
}
