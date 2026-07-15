import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { logAudit } from '../services/audit.service.js';
import type { User } from '@timemark/shared';

const rules = new Hono<{ Variables: { user: User } }>();
rules.use('*', authMiddleware);

rules.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const result = await query(
    'SELECT * FROM conditional_reminder_rules WHERE user_id = $1 ORDER BY days_before',
    [userId],
  );
  return c.json({ success: true, data: result.rows });
});

rules.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const { daysBefore, channels } = await c.req.json().catch(() => ({}));
  if (typeof daysBefore !== 'number' || !Array.isArray(channels)) {
    return c.json({ success: false, error: 'daysBefore 与 channels 必填' }, 400);
  }
  const result = await query(
    `INSERT INTO conditional_reminder_rules (user_id, days_before, channels)
     VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [userId, daysBefore, JSON.stringify(channels)],
  );
  await logAudit(userId, 'create', 'conditional_rule', result.rows[0].id, { daysBefore, channels });
  return c.json({ success: true, data: result.rows[0] }, 201);
});

rules.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseInt(c.req.param('id'), 10);
  await query('DELETE FROM conditional_reminder_rules WHERE id = $1 AND user_id = $2', [id, userId]);
  await logAudit(userId, 'delete', 'conditional_rule', id);
  return c.json({ success: true });
});

export default rules;
