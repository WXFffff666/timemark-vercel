import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { getUserConfig, saveUserConfig } from '../services/config.service.js';
import type { User } from '@timemark/shared';

const config = new Hono<{ Variables: { user: User } }>();

config.use('*', authMiddleware);

config.get('/', async (c) => {
  const user = c.get('user');
  const data = await getUserConfig(Number(user.id));
  return c.json({ success: true, data: data || {} });
});

config.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  await saveUserConfig(Number(user.id), body || {});
  return c.json({ success: true });
});

export default config;
