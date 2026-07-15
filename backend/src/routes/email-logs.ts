import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { deleteEmailLogs, listEmailLogs } from '../services/email-log.service.js';

const emailLogs = new Hono<{ Variables: { user: User } }>();
emailLogs.use('*', authMiddleware);

emailLogs.get('/', async (c) => {
  const user = c.get('user');
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 500);
  const rows = await listEmailLogs(Number(user.id), limit);
  return c.json({ success: true, data: rows });
});

emailLogs.delete('/', async (c) => {
  const user = c.get('user');
  const deleted = await deleteEmailLogs(Number(user.id));
  return c.json({ success: true, data: { deleted } });
});

export default emailLogs;
