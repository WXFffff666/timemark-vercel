import { Hono } from 'hono';
import { timingSafeEqual } from 'crypto';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions } from '../jobs/tasks.js';
import { processNotificationRetries } from '../services/notification-retry.service.js';
import { purgeExpiredLogs } from '../services/retention.service.js';
import { syncAllExternalCalendars } from '../services/calendar-sync.service.js';
import { syncAllCalDavSubscriptions } from '../services/caldav-sync.service.js';
import { syncAllGoogleCalendars } from '../services/google-calendar-sync.service.js';
import { sendLunarPhaseReminders } from '../services/lunar-reminders.service.js';
import { aggregateDailyStats } from '../services/stats-daily.service.js';
import { purgeExpiredEventCache } from '../services/event-cache.service.js';
import { purgeOldInboxMessages } from '../services/inbox.service.js';
import { purgeOldTodoCompletions } from '../services/todo.service.js';
import { query } from '../db/index.js';
import { pingHeartbeat } from '../utils/heartbeat.js';
import { testConnection, type TestConnectionResult } from '../services/notifications/test-connection.js';
import { isSupportedChannel } from '../services/notifications/supported-channels.js';
import { getChannelTemplate } from '../services/notifications/channels.config.js';
import { resolveEmailRecipientForTest } from '../utils/notification-recipients.js';
import { getCronSecret } from '../utils/heartbeat.js';
import { decrypt } from '@timemark/shared/crypto';
import { createLogger } from '../utils/logger.js';

const cronRoutes = new Hono();
const log = createLogger('cron');

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
  } catch (error) {
    // Table may not exist on very old DBs — log and continue, never crash the job.
    log.warn(
      { event: 'cron.execution_log_write_failed', job: jobName, err: error },
      'Failed to write cron execution log',
    );
  }
}

// Auth: external callers use Bearer CRON_SECRET; Vercel built-in cron may send
// x-vercel-cron-auth-token (infra-validated) and/or Bearer CRON_SECRET.
// Multiple schedulers (Vercel daily + cron-job.org minute-level) can run in parallel;
// reminder_send_claims prevents duplicate notification sends.
cronRoutes.use('*', async (c, next) => {
  const cronSecret = getCronSecret();
  if (!cronSecret) {
    return c.json({ error: 'CRON_SECRET / CRONSECRET not configured' }, 500);
  }
  const authHeader = c.req.header('Authorization') || '';
  const expected = `Bearer ${cronSecret}`;
  let bearerOk = false;
  try {
    const a = Buffer.from(authHeader);
    const b = Buffer.from(expected);
    bearerOk = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    bearerOk = false;
  }
  // Always require CRON_SECRET Bearer — x-vercel-cron-auth-token alone is not sufficient
  if (!bearerOk) {
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
  } catch (error) {
    // Gap alerting is advisory only — never let it break reminder-check.
    log.warn(
      { event: 'cron.gap_alert_failed', job: jobName, err: error },
      'Cron gap alert check failed',
    );
  }
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
    // Bounded growth of the append-only logging tables (see services/retention.service.ts):
    // trigger logs 180d, email logs 180d, login attempts 90d, queue 30d after completion/death.
    const purged = await purgeExpiredLogs();
    await purgeExpiredEventCache();
    const purgedInbox = await purgeOldInboxMessages();
    const purgedTodos = await purgeOldTodoCompletions();
    const purgedCronLogs = await query(
      `DELETE FROM cron_execution_logs WHERE executed_at < NOW() - INTERVAL '90 days'`,
    );
    const aggregatedStats = await aggregateDailyStats();
    const pluginResult = await query('DELETE FROM plugin_sessions WHERE expires_at < NOW()');
    await logCronRun(
      'daily-maintenance',
      'success',
      startedAt,
      `sessions cleaned; retries: ${retryStats.succeeded}/${retryStats.processed}; purged trigger logs: ${purged.triggerLogs}; purged emails: ${purged.emailLogs}; purged login attempts: ${purged.loginAttempts}; purged queue: ${purged.notificationQueue}; purged inbox: ${purgedInbox}; purged todos: ${purgedTodos}; purged cron logs: ${purgedCronLogs.rowCount ?? 0}; stats: ${aggregatedStats}`,
    );
    await pingHeartbeat('daily-maintenance');
    return c.json({
      success: true,
      job: 'daily-maintenance',
      timestamp: new Date().toISOString(),
      pluginSessionsDeleted: pluginResult.rowCount ?? 0,
      purged,
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
//
// Truthfulness rules (plan checkbox 11):
//  - A channel type with no test path is reported as 'unknown' + 'unsupported', never 'unhealthy'.
//  - Credentials are stored AES-256-GCM encrypted; they must be decrypted before the test.
//  - This cron NEVER auto-disables an account. Only the send path's 3-consecutive-failure
//    rule (services/notifications/index.ts) may set is_active = FALSE.

export type ChannelHealthStatus = 'healthy' | 'unhealthy' | 'unknown';
export type ChannelHealthLastResult = 'success' | 'failed' | 'unsupported' | 'error' | 'decrypt_failed';

/** Message test-connection.ts returns when a channel type/method has no dedicated test path. */
const UNSUPPORTED_TEST_MESSAGE_RE = /^暂不支持测试|^未知的配置方式/;

/**
 * Single source of truth for mapping a connection-test outcome onto
 * notification_accounts.connection_status / last_test_result.
 * Shared by the daily channel-health cron and the single-channel test route.
 */
export function classifyChannelTestResult(result: Pick<TestConnectionResult, 'success' | 'message'>): {
  connectionStatus: ChannelHealthStatus;
  lastTestResult: ChannelHealthLastResult;
} {
  if (result.success) {
    return { connectionStatus: 'healthy', lastTestResult: 'success' };
  }
  if (UNSUPPORTED_TEST_MESSAGE_RE.test(result.message ?? '')) {
    return { connectionStatus: 'unknown', lastTestResult: 'unsupported' };
  }
  return { connectionStatus: 'unhealthy', lastTestResult: 'failed' };
}

// Old hardcoded default key; mirrors config.service.ts so docker-era rows stay readable.
const LEGACY_MASTER_KEY = 'timemark-default-master-key-change-in-production-2026';

interface AccountCredentials {
  webhook?: string;
  token?: string;
  secret?: string;
  chatId?: string;
  decryptFailed: boolean;
}

/** Decrypt notification_accounts credential columns for a health check. */
function decryptAccountCredentials(row: {
  webhook?: string | null;
  token?: string | null;
  secret?: string | null;
  chat_id?: string | null;
}): AccountCredentials {
  const masterKey = process.env.MASTER_KEY;
  const decode = (raw: unknown): { value?: string; failed: boolean } => {
    if (raw == null || raw === '') return { failed: false };
    if (typeof raw !== 'string') return { failed: true };
    if (masterKey) {
      try { return { value: decrypt(raw, masterKey), failed: false }; } catch { /* try legacy key */ }
    }
    try { return { value: decrypt(raw, LEGACY_MASTER_KEY), failed: false }; } catch { /* maybe plaintext */ }
    // Both keys failed. Historical plaintext rows remain testable (config.service treats
    // this case the same way); a base64 ciphertext blob means the key no longer matches
    // the data, so the account genuinely cannot be tested.
    const looksLikeCiphertext = raw.length >= 40
      && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)
      && Buffer.from(raw, 'base64').length >= 29;
    return looksLikeCiphertext ? { failed: true } : { value: raw, failed: false };
  };

  const webhook = decode(row.webhook);
  const token = decode(row.token);
  const secret = decode(row.secret);
  const chatId = decode(row.chat_id);
  return {
    webhook: webhook.value,
    token: token.value,
    secret: secret.value,
    chatId: chatId.value,
    decryptFailed: webhook.failed || token.failed || secret.failed || chatId.failed,
  };
}

/**
 * Persist health fields only — never is_active. A rejected write (e.g. a stray
 * CHECK constraint on connection_status) must not crash the whole job.
 */
async function persistAccountHealth(
  accountId: number,
  connectionStatus: ChannelHealthStatus,
  lastTestResult: ChannelHealthLastResult,
): Promise<void> {
  try {
    await query(
      `UPDATE notification_accounts SET connection_status = $1, last_test_result = $2, last_test_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [connectionStatus, lastTestResult, accountId],
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[channel-health] Failed to persist status for account ${accountId}: ${message}`);
  }
}

cronRoutes.get('/channel-health', async (c) => {
  const startedAt = Date.now();
  let tested = 0;
  let ok = 0;
  let failed = 0;
  let unsupported = 0;
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
        const credentials = decryptAccountCredentials(row);
        if (credentials.decryptFailed) {
          // Credentials cannot be read -> cannot be tested -> unknown, never unhealthy.
          unsupported++;
          await persistAccountHealth(row.id, 'unknown', 'decrypt_failed');
          continue;
        }
        const chatId = await resolveEmailRecipientForTest(
          row.user_id as number,
          row.type as string,
          credentials.chatId ?? null,
        );
        const result = await testConnection({
          type: row.type,
          configMethod: row.config_method || tpl.configMethod,
          webhook: credentials.webhook,
          token: credentials.token,
          chatId: chatId || undefined,
          secret: credentials.secret,
        });
        const classified = classifyChannelTestResult(result);
        if (classified.connectionStatus === 'healthy') ok++;
        else if (classified.connectionStatus === 'unhealthy') failed++;
        else unsupported++;
        await persistAccountHealth(row.id, classified.connectionStatus, classified.lastTestResult);
      } catch (error: unknown) {
        // One account failing unexpectedly must not abort the whole job.
        unsupported++;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[channel-health] Account ${row.id} (${row.type}) test errored: ${message}`);
        await persistAccountHealth(row.id, 'unknown', 'error');
      }
    }
    const summary = `tested=${tested} ok=${ok} failed=${failed} unsupported=${unsupported}`;
    await logCronRun('channel-health', 'success', startedAt, summary);
    await pingHeartbeat('channel-health');
    return c.json({ success: true, job: 'channel-health', tested, ok, failed, unsupported });
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
