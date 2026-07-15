import { Context, Next } from 'hono';
import { createHash } from 'crypto';
import { query } from '../db/index.js';
import { getUserById } from '../services/auth.service.js';
import type { User } from '@timemark/shared';

function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return ['read', 'write'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function apiKeyMiddleware(c: Context<{ Variables: { user: User; apiScopes?: string[] } }>, next: Next) {
  const apiKey = c.req.header('X-API-Key');

  if (!apiKey) {
    return c.json({ success: false, error: 'API key required' }, 401);
  }

  if (apiKey.length < 32) {
    return c.json({ success: false, error: 'Invalid API key format' }, 401);
  }

  const hashedKey = createHash('sha256').update(apiKey).digest('hex');

  let result = await query(
    'SELECT user_id, api_scopes FROM user_configs WHERE api_key_hash = $1',
    [hashedKey],
  );

  if (result.rows.length === 0) {
    result = await query(
      'SELECT user_id, api_scopes FROM user_configs WHERE api_key = $1',
      [apiKey],
    );
  }

  if (result.rows.length === 0) {
    return c.json({ success: false, error: 'Invalid API key' }, 401);
  }

  const scopes = parseScopes(result.rows[0].api_scopes);
  const method = c.req.method.toUpperCase();
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (isWrite && !scopes.includes('write')) {
    return c.json({ success: false, error: 'API Key 无 write 权限' }, 403);
  }

  const userId = result.rows[0].user_id;
  const user = await getUserById(userId.toString());

  if (!user) {
    return c.json({ success: false, error: 'User not found' }, 401);
  }

  c.set('user', user);
  c.set('apiScopes', scopes);
  await next();
}
