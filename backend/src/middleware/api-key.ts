import { Context, Next } from 'hono';
import { query } from '../db/index.js';
import { getUserById } from '../services/auth.service.js';
import type { User } from '@timemark/shared';

export async function apiKeyMiddleware(c: Context<{ Variables: { user: User } }>, next: Next) {
  const apiKey = c.req.header('X-API-Key');

  if (!apiKey) {
    return c.json({ success: false, error: 'API key required' }, 401);
  }

  // Validate API key format
  if (apiKey.length < 32) {
    return c.json({ success: false, error: 'Invalid API key format' }, 401);
  }

  // Look up user by API key (stored in user_configs)
  const result = await query(
    'SELECT user_id FROM user_configs WHERE api_key = $1',
    [apiKey]
  );

  if (result.rows.length === 0) {
    return c.json({ success: false, error: 'Invalid API key' }, 401);
  }

  const userId = result.rows[0].user_id;
  const user = await getUserById(userId.toString());

  if (!user) {
    return c.json({ success: false, error: 'User not found' }, 401);
  }

  c.set('user', user);
  await next();
}
