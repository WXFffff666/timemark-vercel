import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';

const triggerLogs = new Hono<{ Variables: { user: User } }>();

triggerLogs.use('*', authMiddleware);

// 获取事件触发日志
triggerLogs.get('/', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  try {
    const result = await query(
      `SELECT tl.*, e.name as event_name, e.type as event_type
       FROM event_trigger_logs tl
       LEFT JOIN events e ON tl.event_id = e.id
       WHERE tl.user_id = ?
       ORDER BY tl.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    const countResult = await query(
      'SELECT COUNT(*) as total FROM event_trigger_logs WHERE user_id = ?',
      [userId]
    );

    return c.json({
      success: true,
      data: result.rows,
      pagination: {
        total: countResult.rows[0]?.total || 0,
        limit,
        offset,
      },
    });
  } catch (error: any) {
    console.error('[TriggerLogs] Failed to fetch:', error);
    return c.json({ success: false, error: error.message || 'Failed to fetch logs' }, 500);
  }
});

// 清除触发日志
triggerLogs.delete('/', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);

  try {
    const result = await query('DELETE FROM event_trigger_logs WHERE user_id = ?', [userId]);
    return c.json({ success: true, data: { deleted: result.rowCount } });
  } catch (error: any) {
    console.error('[TriggerLogs] Failed to clear:', error);
    return c.json({ success: false, error: error.message || 'Failed to clear logs' }, 500);
  }
});

export default triggerLogs;
