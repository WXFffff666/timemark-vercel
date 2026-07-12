import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { ensureLunarHolidayEvents } from '../services/lunar-holidays.js';
import type { User } from '@timemark/shared';

const userRoutes = new Hono<{ Variables: { user: User } }>();

userRoutes.use('*', authMiddleware);

userRoutes.get('/profile', async (c) => {
  const user = c.get('user');
  const result = await query(
    `SELECT u.id, u.username, u.avatar_url, u.created_at, uc.password_changed_at
     FROM users u
     LEFT JOIN user_configs uc ON uc.user_id = u.id
     WHERE u.id = $1`,
    [user.id],
  );
  if (result.rows.length === 0) {
    return c.json({ success: false, error: 'User not found' }, 404);
  }
  return c.json({ success: true, data: result.rows[0] });
});

userRoutes.put('/profile', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const username = typeof body.username === 'string' ? body.username.trim() : '';

  if (username.length < 2 || username.length > 32) {
    return c.json({ success: false, error: 'Username must be 2-32 characters' }, 400);
  }

  const existing = await query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, user.id]);
  if (existing.rows.length > 0) {
    return c.json({ success: false, error: 'Username already taken' }, 409);
  }

  await query('UPDATE users SET username = $1 WHERE id = $2', [username, user.id]);
  return c.json({ success: true, data: { id: user.id, username } });
});

userRoutes.post('/sync-holidays', async (c) => {
  const user = c.get('user');
  await ensureLunarHolidayEvents(Number(user.id));
  return c.json({ success: true, data: { synced: true } });
});

export default userRoutes;
