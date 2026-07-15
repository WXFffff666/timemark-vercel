import { Hono } from 'hono';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions } from '../jobs/tasks.js';
import { processNotificationRetries, purgeOldQueueEntries } from '../services/notification-retry.service.js';
import { purgeOldEmailLogs } from '../services/email-log.service.js';
import { syncAllExternalCalendars } from '../services/calendar-sync.service.js';
import { purgeExpiredEventCache } from '../services/event-cache.service.js';
import { query } from '../db/index.js';
import { pingHeartbeat } from '../utils/heartbeat.js';
import { testConnection } from '../services/notifications/test-connection.js';
import { isSupportedChannel } from '../services/notifications/supported-channels.js';
import { getChannelTemplate } from '../services/notifications/channels.config.js';
import { resolveEmailRecipientForTest } from '../utils/notification-recipients.js';

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
    await pingHeartbeat('reminder-check');
    return c.json({ success: true, job: 'reminder-check', timestamp: new Date().toISOString() });
  } catch (error: any) {
    await logCronRun('reminder-check', 'failed', startedAt, undefined, error.message);
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

// Sync external ICS calendars — call every 15 min via external cron
cronRoutes.get('/calendar-sync', async (c) => {
  const startedAt = Date.now();
  try {
    await syncAllExternalCalendars();
    await logCronRun('calendar-sync', 'success', startedAt, 'External calendars synced');
    return c.json({ success: true, job: 'calendar-sync' });
  } catch (error: any) {
    await logCronRun('calendar-sync', 'failed', startedAt, undefined, error.message);
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

// Process notification retries — call every 5–15 min via external cron on Vercel Hobby
cronRoutes.get('/retry-notifications', async (c) => {
  const startedAt = Date.now();
  try {
    const stats = await processNotificationRetries();
    await logCronRun('retry-notifications', 'success', startedAt, `processed ${stats.processed}, ok ${stats.succeeded}`);
    return c.json({ success: true, job: 'retry-notifications', ...stats });
  } catch (error: any) {
    await logCronRun('retry-notifications', 'failed', startedAt, undefined, error.message);
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
    const retryStats = await processNotificationRetries();
    const purgedEmails = await purgeOldEmailLogs();
    const purgedQueue = await purgeOldQueueEntries();
    const purgedCache = await purgeExpiredEventCache();
    const pluginResult = await query('DELETE FROM plugin_sessions WHERE expires_at < NOW()');
    await logCronRun(
      'daily-maintenance',
      'success',
      startedAt,
      `sessions cleaned; retries: ${retryStats.succeeded}/${retryStats.processed}; purged emails: ${purgedEmails}; purged queue: ${purgedQueue}`,
    );
    await pingHeartbeat('daily-maintenance');
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

// Channel health re-check for active accounts (daily via external cron)
cronRoutes.get('/channel-health', async (c) => {
  const startedAt = Date.now();
  let tested = 0;
  let ok = 0;
  let failed = 0;
  try {
    const accounts = await query(
      `SELECT id, user_id, type, webhook, token, secret, chat_id, config_method
       FROM notification_accounts WHERE is_active = TRUE`,
    );
    for (const row of accounts.rows) {
      if (!isSupportedChannel(row.type)) continue;
      const tpl = getChannelTemplate(row.type);
      if (!tpl) continue;
      tested++;
      try {
        const chatId = await resolveEmailRecipientForTest(
          row.user_id as number,
          row.type as string,
          row.chat_id as string | null,
        );
        const result = await testConnection({
          type: row.type,
          configMethod: row.config_method || tpl.configMethod,
          webhook: row.webhook || undefined,
          token: row.token || undefined,
          chatId: chatId || undefined,
          secret: row.secret || undefined,
        });
        const status = result.success ? 'healthy' : 'unhealthy';
        if (result.success) ok++; else failed++;
        await query(
          `UPDATE notification_accounts SET connection_status = $1, last_test_result = $2, last_test_at = CURRENT_TIMESTAMP WHERE id = $3`,
          [status, result.success ? 'success' : 'failed', row.id],
        );
      } catch {
        failed++;
        await query(
          `UPDATE notification_accounts SET connection_status = 'unhealthy', last_test_result = 'failed', last_test_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [row.id],
        ).catch(() => {});
      }
    }
    const summary = `tested=${tested} ok=${ok} failed=${failed}`;
    await logCronRun('channel-health', 'success', startedAt, summary);
    await pingHeartbeat('channel-health');
    return c.json({ success: true, job: 'channel-health', tested, ok, failed });
  } catch (error: any) {
    await logCronRun('channel-health', 'failed', startedAt, undefined, error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default cronRoutes;
