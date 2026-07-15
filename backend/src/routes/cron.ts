import { Hono } from 'hono';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions } from '../jobs/tasks.js';
import { query } from '../db/index.js';

const cronRoutes = new Hono();

async function logCronRun(
  jobName: string,
  status: 'success' | 'failed',
  startedAt: number,
  summary?: string,
  errorMessage?: string,
) {
  try {
    await query(
      `INSERT INTO cron_execution_logs (job_name, status, duration_ms, result_summary, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobName, status, Date.now() - startedAt, summary ?? null, errorMessage ?? null],
    );
  } catch {
    // Table may not exist on very old DBs — ignore
  }
}

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
  const allowedIps = (process.env.CRON_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowedIps.length > 0) {
    const ip = c.req.header('x-vercel-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || '';
    if (ip && !allowedIps.includes(ip)) {
      return c.json({ error: 'IP not allowed' }, 403);
    }
  }
  await next();
});

// Warmup — reduce cold start (call from external cron before reminder-check)
cronRoutes.get('/warmup', async (c) => {
  try {
    await query('SELECT 1');
    return c.json({ success: true, warmed: true, timestamp: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 1. Reminder check — call every minute via cron-job.org (free) on Vercel Hobby
cronRoutes.get('/reminder-check', async (c) => {
  const startedAt = Date.now();
  try {
    await sendReminders();
    await logCronRun('reminder-check', 'success', startedAt, 'Reminders checked');
    return c.json({ success: true, job: 'reminder-check', timestamp: new Date().toISOString() });
  } catch (error: any) {
    await logCronRun('reminder-check', 'failed', startedAt, undefined, error.message);
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

// 2. Daily maintenance — Vercel Hobby built-in cron (once per day)
cronRoutes.get('/daily-maintenance', async (c) => {
  const startedAt = Date.now();
  try {
    await cleanupSessions();
    await githubBackup();
    await archiveLoginHistory();
    const pluginResult = await query('DELETE FROM plugin_sessions WHERE expires_at < NOW()');
    await logCronRun(
      'daily-maintenance',
      'success',
      startedAt,
      `sessions cleaned; plugin_sessions deleted: ${pluginResult.rowCount ?? 0}`,
    );
    return c.json({
      success: true,
      job: 'daily-maintenance',
      timestamp: new Date().toISOString(),
      pluginSessionsDeleted: pluginResult.rowCount ?? 0,
    });
  } catch (error: any) {
    await logCronRun('daily-maintenance', 'failed', startedAt, undefined, error.message);
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

// Legacy endpoints — still callable via external cron if needed
cronRoutes.get('/daily-email-backup', async (c) => {
  try {
    await githubBackup();
    return c.json({ success: true, job: 'daily-email-backup', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

cronRoutes.get('/daily-login-backup', async (c) => {
  try {
    await archiveLoginHistory();
    return c.json({ success: true, job: 'daily-login-backup', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

cronRoutes.get('/hourly-cleanup', async (c) => {
  try {
    await cleanupSessions();
    return c.json({ success: true, job: 'hourly-cleanup', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

cronRoutes.get('/plugin-session-cleanup', async (c) => {
  try {
    const result = await query('DELETE FROM plugin_sessions WHERE expires_at < NOW()');
    return c.json({ success: true, job: 'plugin-session-cleanup', timestamp: new Date().toISOString(), deleted: result.rowCount ?? 0 });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

export default cronRoutes;
