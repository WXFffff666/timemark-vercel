import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { sendReminders } from '../jobs/tasks.js';
import type { User } from '@timemark/shared';

const stats = new Hono<{ Variables: { user: User } }>();
stats.use('*', authMiddleware);

stats.get('/', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  
  const [events, triggers, accounts] = await Promise.all([
    query('SELECT COUNT(*) as count FROM events WHERE user_id = ?', [userId]),
    query(`SELECT status, COUNT(*) as count FROM event_trigger_logs 
           WHERE user_id = ? AND created_at > datetime('now', '-30 days') 
           GROUP BY status`, [userId]),
    query('SELECT type, COUNT(*) as count FROM notification_accounts WHERE user_id = ? AND is_active = 1 GROUP BY type', [userId]),
  ]);
  
  return c.json({
    success: true,
    data: {
      totalEvents: events.rows[0]?.count || 0,
      triggerStats: triggers.rows,
      channelUsage: accounts.rows,
    },
  });
});

stats.get('/scheduler', async (c) => {
  // Local/Docker only; Vercel uses Cron Jobs instead
  if (!process.env.VERCEL) {
    // @ts-expect-error - scheduler.ts deleted in Vercel migration; guarded by !process.env.VERCEL
    const { getSchedulerStatus } = await import('../queue/scheduler.js');
    const status = getSchedulerStatus();
    return c.json({ success: true, data: status });
  }
  return c.json({ success: false, message: 'Scheduler not available in Vercel environment' });
});

stats.post('/trigger-reminders', async (c) => {
  try {
    await sendReminders();
    return c.json({ success: true, message: 'Reminders triggered successfully' });
  } catch (error) {
    return c.json({ success: false, message: `Trigger failed: ${String(error)}` }, 500);
  }
});

export default stats;
