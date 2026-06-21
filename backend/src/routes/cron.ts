import { Hono } from 'hono';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions } from '../jobs/tasks.js';
import { query } from '../db/index.js';

const cronRoutes = new Hono();

// CRON_SECRET Bearer token validation middleware for all cron endpoints
cronRoutes.use('*', async (c, next) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return c.json({ error: 'CRON_SECRET not configured' }, 500);
  }
  const authHeader = c.req.header('Authorization');
  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

// 1. Reminder check — every minute (* * * * *)
cronRoutes.get('/reminder-check', async (c) => {
  try {
    await sendReminders();
    return c.json({ success: true, job: 'reminder-check', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

// 2. Daily email backup — daily at 18:00 UTC (02:00 CST) (0 18 * * *)
cronRoutes.get('/daily-email-backup', async (c) => {
  try {
    await githubBackup();
    return c.json({ success: true, job: 'daily-email-backup', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

// 3. Daily login backup — daily at 19:00 UTC (03:00 CST) (0 19 * * *)
cronRoutes.get('/daily-login-backup', async (c) => {
  try {
    await archiveLoginHistory();
    return c.json({ success: true, job: 'daily-login-backup', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

// 4. Hourly cleanup — every hour at :00 (0 * * * *)
cronRoutes.get('/hourly-cleanup', async (c) => {
  try {
    await cleanupSessions();
    return c.json({ success: true, job: 'hourly-cleanup', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

// 5. Plugin session cleanup — every hour at :30 (30 * * * *)
cronRoutes.get('/plugin-session-cleanup', async (c) => {
  try {
    const result = await query("DELETE FROM plugin_sessions WHERE expires_at < NOW()");
    return c.json({ success: true, job: 'plugin-session-cleanup', timestamp: new Date().toISOString(), deleted: result.rowCount ?? 0 });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

export default cronRoutes;
