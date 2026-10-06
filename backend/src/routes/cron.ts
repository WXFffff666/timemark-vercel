import { Hono } from 'hono';
import { timingSafeEqual } from 'crypto';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions, CRON_GAP_ALERT_MINUTES } from '../jobs/tasks.js';
import { processNotificationRetries } from '../services/notification-retry.service.js';
import { purgeExpiredLogs } from '../services/retention.service.js';
import { syncAllExternalCalendars } from '../services/calendar-sync.service.js';
import { syncAllCalDavSubscriptions, syncCalDavWriteBack, type CalDavWriteBackStats } from '../services/caldav-sync.service.js';
import { syncAllGoogleCalendars } from '../services/google-calendar-sync.service.js';
import { sendLunarPhaseReminders } from '../services/lunar-reminders.service.js';
import { aggregateDailyStats } from '../services/stats-daily.service.js';
import { recomputeAllUserPatterns } from '../services/patterns.service.js';
import { cleanupOrphanEmbeddings, indexEmbeddingsBatch } from '../services/search.service.js';
import { isEmbeddingsEnabled } from '../services/ai/embeddings.js';
import { purgeExpiredEventCache } from '../services/event-cache.service.js';
import { purgeOldInboxMessages } from '../services/inbox.service.js';
import { purgeOldTodoCompletions } from '../services/todo.service.js';
import { purgeOldHabitLogs } from '../services/habit.service.js';
import { materializeUpcomingDoses, markMissedDoses, purgeOldMedicationDoses } from '../services/medication.service.js';
import { purgeOrphanAttachments } from '../services/attachment-retention.service.js';
import { sendDigestsForAllUsers, type DigestPeriod } from '../services/digest.service.js';
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
  const durationMs = Date.now() - startedAt;
  try {
    // v2.26: 成功 → cron_job_status upsert（每 job 恒一行，替代每分钟一条的
    // 无限增长；/api/health 与 cron-monitor 读这张有界表，不再全表排序）。
    // 失败 → 保留 cron_execution_logs 明细行（30 天清理）便于排障。
    await query(
      `INSERT INTO cron_job_status (job_name, last_status, last_ok_at, last_error, last_summary, last_duration_ms, updated_at)
       VALUES ($1, $2, CASE WHEN $2 = 'success' THEN NOW() ELSE NULL END, $3, $5, $4, NOW())
       ON CONFLICT (job_name) DO UPDATE SET
         last_status = EXCLUDED.last_status,
         last_ok_at = CASE WHEN EXCLUDED.last_status = 'success' THEN NOW() ELSE cron_job_status.last_ok_at END,
         last_error = EXCLUDED.last_error,
         last_summary = EXCLUDED.last_summary,
         last_duration_ms = EXCLUDED.last_duration_ms,
         updated_at = NOW()`,
      [jobName, status, errorMessage ?? null, durationMs, summary ?? null],
    );
    if (status === 'failed') {
      await query(
        `INSERT INTO cron_execution_logs (job_name, status, duration_ms, result_summary, error_message)
         VALUES ($1, $2, $3, $4, $5)`,
        [jobName, status, durationMs, summary ?? null, errorMessage ?? null],
      );
    }
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

/** B29: Cron 间隔 >3min 告警（阈值 = tasks.ts 的 CRON_GAP_ALERT_MINUTES；checkbox 166 的补发
 *  日志复用同一常量，但告警通道本身保持不变）。导出供测试直接驱动。 */
export async function checkCronGapAlert(jobName: string): Promise<void> {
  try {
    const prev = await query(
      `SELECT executed_at FROM cron_execution_logs
       WHERE job_name = $1 AND status = 'success'
       ORDER BY executed_at DESC LIMIT 1 OFFSET 1`,
      [jobName],
    );
    if (!prev.rows[0]?.executed_at) return;
    const gapMs = Date.now() - new Date(prev.rows[0].executed_at as string).getTime();
    if (gapMs > CRON_GAP_ALERT_MINUTES * 60 * 1000) {
      const admins = await query(`SELECT user_id FROM user_configs WHERE alert_channels IS NOT NULL LIMIT 1`);
      if (admins.rows[0]) {
        const { createInboxMessage } = await import('../services/inbox.service.js');
        await createInboxMessage({
          userId: admins.rows[0].user_id as number,
          title: 'Cron 执行间隔异常',
          body: `${jobName} 距上次成功已超过 ${Math.round(gapMs / 60000)} 分钟`,
          // v2.30 修复：收件箱列表只展示 source='inbound'，写成 broadcast 的告警
          // 在 UI 里永远不可见（摸底发现的断点）。
          source: 'inbound',
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

// Periodic digest (checkbox 79) — call monthly (and optionally yearly) via the external
// cron list. Auth is the shared CRON_SECRET middleware (401 without `Bearer <secret>`).
// The job deliberately does NOT consult `cron_execution_logs`: a stale row for the same
// period can never skip a digest run.
cronRoutes.get('/digest', async (c) => {
  const startedAt = Date.now();
  const periodRaw = c.req.query('period') ?? 'monthly';
  if (periodRaw !== 'monthly' && periodRaw !== 'yearly') {
    return c.json({ success: false, error: 'period must be monthly or yearly' }, 400);
  }
  const period = periodRaw as DigestPeriod;
  try {
    const stats = await sendDigestsForAllUsers(period);
    await logCronRun(`digest-${period}`, 'success', startedAt, `sent ${stats.sent}/${stats.users}`);
    return c.json({ success: true, job: `digest-${period}`, users: stats.users, sent: stats.sent, skipped: stats.skipped });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await logCronRun(`digest-${period}`, 'failed', startedAt, undefined, message);
    return c.json({ success: false, error: message || 'Job failed' }, 500);
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
    // Habit logs follow the same 365-day retention as todo completions (checkbox 64).
    const purgedHabitLogs = await purgeOldHabitLogs();
    // Medications (D3, checkbox 72): materialise today+tomorrow's doses (idempotent)
    // and close out yesterday's unlogged pending doses as missed; 365-day dose history.
    const materializedDoses = await materializeUpcomingDoses(undefined, 1);
    const missedDoses = await markMissedDoses();
    const purgedDoses = await purgeOldMedicationDoses();
    // Attachment retention (todo 57): orphan rows (no owner row) older than 30 days,
    // rows first then objects. Referenced attachments are never touched.
    const purgedAttachments = await purgeOrphanAttachments();
    // v2.26: cron_execution_logs 只剩失败明细（成功路径迁 cron_job_status upsert）→ 30 天
    const purgedCronLogs = await query(
      `DELETE FROM cron_execution_logs WHERE executed_at < NOW() - INTERVAL '30 days'`,
    );
    // v2.26: 接线此前从未被调用的 agent jobs/events 清理（job-hardening 死代码激活）
    const { purgeTerminalAgentJobs } = await import('../services/agent/job-hardening.service.js');
    const purgedAgentJobs = await purgeTerminalAgentJobs().catch((err: unknown) => {
      console.warn('[daily-maintenance] agent job purge failed:', err instanceof Error ? err.message : err);
      return { purgedJobs: 0, purgedEvents: 0 };
    });
    const aggregatedStats = await aggregateDailyStats();
    // Checkbox 105: deterministic behavioural-pattern miner (no LLM, no external call).
    // Replaces each user's prior rows, so a timezone change re-buckets on the next night.
    const minedPatterns = await recomputeAllUserPatterns();
    // Checkbox 106 (OPT-IN): bounded embedding refresh + orphan cleanup. With
    // EMBEDDINGS_ENABLED unset (the default) this branch is skipped entirely - the nightly
    // job issues no embeddings query and no provider call. The provider failure is
    // reported in the cron summary instead of aborting the other maintenance steps.
    let embeddingSummary = 'embeddings: disabled';
    if (isEmbeddingsEnabled()) {
      const indexed = await indexEmbeddingsBatch();
      const orphans = await cleanupOrphanEmbeddings();
      embeddingSummary = indexed.tableReady
        ? `embeddings: ${indexed.embedded} embedded, ${indexed.skipped} unchanged, ${indexed.failed} failed, ${orphans.removed} orphaned removed${indexed.error ? ` (${indexed.error})` : ''}`
        : 'embeddings: table not present (pgvector unavailable)';
    }
    const pluginResult = await query('DELETE FROM plugin_sessions WHERE expires_at < NOW()');
    await logCronRun(
      'daily-maintenance',
      'success',
      startedAt,
      `sessions cleaned; retries: ${retryStats.succeeded}/${retryStats.processed}; purged trigger logs: ${purged.triggerLogs}; purged emails: ${purged.emailLogs}; purged login attempts: ${purged.loginAttempts}; purged queue: ${purged.notificationQueue}; purged inbox: ${purgedInbox}; purged todos: ${purgedTodos}; purged habit logs: ${purgedHabitLogs}; doses materialized: ${materializedDoses}; doses missed: ${missedDoses}; purged doses: ${purgedDoses}; purged orphan attachments: ${purgedAttachments.purged}; purged cron logs: ${purgedCronLogs.rowCount ?? 0}; stats: ${aggregatedStats}; patterns: ${minedPatterns.patterns} for ${minedPatterns.users} user(s); ${embeddingSummary}`,
    );
    await pingHeartbeat('daily-maintenance');
    return c.json({
      success: true,
      job: 'daily-maintenance',
      timestamp: new Date().toISOString(),
      pluginSessionsDeleted: pluginResult.rowCount ?? 0,
      purged,
      purgedAttachments,
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

// C1 CalDAV 只读订阅 + 可选回写（checkbox 86，默认关闭）
cronRoutes.get('/caldav-sync', async (c) => {
  const startedAt = Date.now();
  try {
    const stats = await syncAllCalDavSubscriptions();
    // Opt-in write-back rides along with the existing invocation: no extra cron
    // job, no standing compute, and a single cheap SELECT when no user enabled it.
    let writeBack: CalDavWriteBackStats | { error: string };
    try {
      writeBack = await syncCalDavWriteBack();
    } catch (writeBackError: unknown) {
      const message = writeBackError instanceof Error ? writeBackError.message : String(writeBackError);
      log.warn({ err: writeBackError }, 'CalDAV write-back failed; read-only sync result is still reported');
      writeBack = { error: message };
    }
    const writeBackSummary =
      'error' in writeBack
        ? `writeback=error`
        : `writeback created=${writeBack.created} updated=${writeBack.updated} deleted=${writeBack.deleted} skipped=${writeBack.skipped} failed=${writeBack.failed}`;
    await logCronRun('caldav-sync', 'success', startedAt, `synced ${stats.synced} ${writeBackSummary}`);
    return c.json({ success: true, job: 'caldav-sync', ...stats, writeBack });
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
