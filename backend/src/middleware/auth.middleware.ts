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
  console.log('[authMiddleware] Token payload:', payload);
  
  if (!payload) {
    return c.json({ success: false, error: 'Invalid token' }, 401);
  }

  console.log('[authMiddleware] Calling getUserById with:', payload.userId);
  const user = await getUserById(payload.userId);
  console.log('[authMiddleware] getUserById returned:', user);

  if (!user) {
    return c.json({ success: false, error: 'User not found' }, 401);
  }

  c.set('user', user);
  await next();
}
