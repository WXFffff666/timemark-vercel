import { Hono } from 'hono';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions } from '../jobs/tasks.js';
import { processNotificationRetries, purgeOldQueueEntries } from '../services/notification-retry.service.js';
import { purgeOldEmailLogs } from '../services/email-log.service.js';
import { syncAllExternalCalendars } from '../services/calendar-sync.service.js';
import { syncAllCalDavSubscriptions } from '../services/caldav-sync.service.js';
import { syncAllGoogleCalendars } from '../services/google-calendar-sync.service.js';
import { sendLunarPhaseReminders } from '../services/lunar-reminders.service.js';
import { aggregateDailyStats } from '../services/stats-daily.service.js';
import { purgeExpiredEventCache } from '../services/event-cache.service.js';
import { purgeOldInboxMessages } from '../services/inbox.service.js';
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

// Auth: external callers use Bearer CRON_SECRET; Vercel built-in cron may send
// x-vercel-cron-auth-token (infra-validated) and/or Bearer CRON_SECRET.
// Multiple schedulers (Vercel daily + cron-job.org minute-level) can run in parallel;
// reminder_send_claims prevents duplicate notification sends.
cronRoutes.use('*', async (c, next) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return c.json({ error: 'CRON_SECRET not configured' }, 500);
  }
  const isVercelCron = !!c.req.header('x-vercel-cron-auth-token');
  const authHeader = c.req.header('Authorization');
  const bearerOk = authHeader === `Bearer ${cronSecret}`;
  if (!isVercelCron && !bearerOk) {
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
// B28: warmup 合并进 reminder-check
cronRoutes.get('/reminder-check', async (c) => {
  const startedAt = Date.now();
  try {
    await query('SELECT 1'); // warmup DB connection
    await sendReminders();
    await checkCronGapAlert('reminder-check');
    await logCronRun('reminder-check', 'success', startedAt, 'Reminders checked');
    await pingHeartbeat('reminder-check');
    return c.json({ success: true, job: 'reminder-check', timestamp: new Date().toISOString() });
  } catch (error: any) {
    await logCronRun('reminder-check', 'failed', startedAt, undefined, error.message);
    return c.json({ success: false, error: error.message || 'Job failed' }, 500);
  }
});

/** B29: Cron 间隔 >3min 告警 */
async function checkCronGapAlert(jobName: string): Promise<void> {
  try {
    const prev = await query(
      `SELECT executed_at FROM cron_execution_logs
       WHERE job_name = $1 AND status = 'success'
       ORDER BY executed_at DESC LIMIT 1 OFFSET 1`,
      [jobName],
    );
    if (!prev.rows[0]?.executed_at) return;
    const gapMs = Date.now() - new Date(prev.rows[0].executed_at as string).getTime();
    if (gapMs > 3 * 60 * 1000) {
      const admins = await query(`SELECT user_id FROM user_configs WHERE alert_channels IS NOT NULL LIMIT 1`);
      if (admins.rows[0]) {
        const { createInboxMessage } = await import('../services/inbox.service.js');
        await createInboxMessage({
          userId: admins.rows[0].user_id as number,
          title: 'Cron 执行间隔异常',
          body: `${jobName} 距上次成功已超过 ${Math.round(gapMs / 60000)} 分钟`,
          source: 'broadcast',
        });
      }
    }
  } catch { /* ignore */ }
}

// Sync external ICS calendars — call every 15 min via external cron
cronRoutes.get('/calendar-sync', async (c) => {
  const startedAt = Date.now();
  try {
    await syncAllExternalCalendars();
    const googleStats = await syncAllGoogleCalendars();
    await logCronRun('calendar-sync', 'success', startedAt, `External + Google synced (${googleStats.synced} imported)`);
    return c.json({ success: true, job: 'calendar-sync', googleImported: googleStats.synced });
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
    const purgedInbox = await purgeOldInboxMessages();
    const purgedCronLogs = await query(
      `DELETE FROM cron_execution_logs WHERE executed_at < NOW() - INTERVAL '90 days'`,
    );
    const aggregatedStats = await aggregateDailyStats();
    const pluginResult = await query('DELETE FROM plugin_sessions WHERE expires_at < NOW()');
    await logCronRun(
      'daily-maintenance',
      'success',
      startedAt,
      `sessions cleaned; retries: ${retryStats.succeeded}/${retryStats.processed}; purged emails: ${purgedEmails}; purged queue: ${purgedQueue}; purged inbox: ${purgedInbox}; purged cron logs: ${purgedCronLogs.rowCount ?? 0}; stats: ${aggregatedStats}`,
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

// C1 CalDAV 只读订阅
cronRoutes.get('/caldav-sync', async (c) => {
  const startedAt = Date.now();
  try {
    const stats = await syncAllCalDavSubscriptions();
    await logCronRun('caldav-sync', 'success', startedAt, `synced ${stats.synced}`);
    return c.json({ success: true, job: 'caldav-sync', ...stats });
  } catch (error: any) {
    await logCronRun('caldav-sync', 'failed', startedAt, undefined, error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// C33 农历初一/十五提醒
cronRoutes.get('/lunar-phase-reminders', async (c) => {
  const startedAt = Date.now();
  try {
    const sent = await sendLunarPhaseReminders();
    await logCronRun('lunar-phase-reminders', 'success', startedAt, `sent ${sent}`);
    return c.json({ success: true, job: 'lunar-phase-reminders', sent });
  } catch (error: any) {
    await logCronRun('lunar-phase-reminders', 'failed', startedAt, undefined, error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default cronRoutes;
