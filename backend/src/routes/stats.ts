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
  
  const [events, triggers, accounts, monthlyTriggers, eventsByType, upcoming] = await Promise.all([
    query('SELECT COUNT(*) as count FROM events WHERE user_id = $1', [userId]),
    query(`SELECT status, COUNT(*) as count FROM event_trigger_logs 
           WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days' 
           GROUP BY status`, [userId]),
    query('SELECT type, COUNT(*) as count FROM notification_accounts WHERE user_id = $1 AND is_active = TRUE GROUP BY type', [userId]),
    query(`SELECT TO_CHAR(created_at, 'YYYY-MM') as month, status, COUNT(*)::int as count
           FROM event_trigger_logs
           WHERE user_id = $1 AND created_at > NOW() - INTERVAL '6 months'
           GROUP BY month, status
           ORDER BY month`, [userId]),
    query(`SELECT type, COUNT(*)::int as count FROM events WHERE user_id = $1 GROUP BY type`, [userId]),
    query(`SELECT COUNT(*)::int as count FROM events WHERE user_id = $1`, [userId]),
  ]);
  
  return c.json({
    success: true,
    data: {
      totalEvents: Number(events.rows[0]?.count || 0),
      activeEvents: Number(upcoming.rows[0]?.count || 0),
      triggerStats: triggers.rows,
      channelUsage: accounts.rows,
      monthlyTriggers: monthlyTriggers.rows,
      eventsByType: eventsByType.rows,
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
