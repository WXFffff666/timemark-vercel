import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { readFileSync } from 'node:fs';

// v2.28 C16：应用版本单一来源 = 根 package.json；读取失败回退 dev 标记
// v2.30 修复：Vercel 生产 bundle 是 esbuild CJS，`import.meta` 为空对象——
// 原先的 `createRequire(import.meta.url)` 在模块求值期即抛错，整个函数冷启动
// 崩溃（500 FUNCTION_INVOCATION_FAILED，v2.28 部署后全站 API 不可用的根因）。
// bundle 由 build-vercel-api.mjs banner 注入 process.env.APP_VERSION，优先取之；
// 本地 dev（tsx ESM）无该值，按 cwd 回退读 package.json。
const APP_VERSION: string =
  process.env.APP_VERSION ||
  (() => {
    try {
      // pnpm dev:backend 的 cwd = backend/ → 根 package.json 在上一级
      for (const p of ['../package.json', '../../package.json', 'package.json']) {
        try {
          return String((JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version ?? 'dev');
        } catch { /* try next path */ }
      }
      return 'dev';
    } catch {
      return 'dev';
    }
  })();
import { requestIdMiddleware } from './middleware/request-id.js';
import { securityHeaders } from './middleware/security-headers.js';
import { zeroTrustGuard } from './middleware/zero-trust-guard.js';
import { httpsEnforcement } from './middleware/https-enforcement.js';
import { csrfProtection } from './middleware/csrf.js';
import { apiRateLimit, rateLimit } from './middleware/rate-limit.js';
import { getConfiguredOrigins, isAllowedOrigin } from './utils/allowed-origins.js';
import 'dotenv/config';
import { createLogger } from './utils/logger.js';
import { waitForDb, query } from './db/index.js';
import { runMigrations, migrateEncryptionKey } from './db/migrate.js';
import { initSecretKeys } from './utils/secrets.js';
import { isTurnstileEnabled, getTurnstileSiteKey } from './utils/turnstile.js';
import { getClockOffsetMs, getLastTimeSyncResult, scheduleTimeSync, DEFAULT_SYNC_TIMEZONE } from './utils/ntp.js';
import { getCronSecret } from './utils/heartbeat.js';
import { inferDatabaseRegionHint, isPreferredCnVercelRegion } from './utils/infra-region.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import configRoutes from './routes/config.js';
import channelsRoutes from './routes/channels.js';
import statsRoutes from './routes/stats.js';
import backupRoutes from './routes/backup.js';
import calendarRoutes from './routes/calendar.js';
import pushRoutes from './routes/push.js';
import cronRoutes from './routes/cron.js';
import dataRoutes from './routes/data.js';
import triggerLogRoutes from './routes/trigger-logs.js';
import userRoutes from './routes/user.js';
import featuresRoutes from './routes/features.js';
import securityRoutes from './routes/security.js';
import calendarImportRoutes from './routes/calendar-import.js';
import googleCalendarRoutes from './routes/google-calendar.js';
import contactsRoutes from './routes/contacts.js';
import broadcastRoutes from './routes/broadcast.js';
import webauthnRoutes from './routes/webauthn.js';
import emailLogsRoutes from './routes/email-logs.js';
import webhookInboundRoutes from './routes/webhook-inbound.js';
import calendarPublicRoutes from './routes/calendar-public.js';
import publicIcsRoutes from './routes/public-ics.js';
import inboxRoutes from './routes/inbox.js';
import inboxPublicRoutes from './routes/inbox-public.js';
import cronMonitorRoutes from './routes/cron-monitor.js';
import resendWebhookRoutes from './routes/resend-webhook.js';
import conditionalRulesRoutes from './routes/conditional-rules.js';
import todosRoutes from './routes/todos.js';
import cspReportRoutes from './routes/csp-report.js';
import greetingsRoutes from './routes/greetings.js';
import timeRoutes from './routes/time.js';
import expiryRoutes from './routes/expiry.js';
import inventoryRoutes from './routes/inventory.js';
import maintenanceRoutes from './routes/maintenance.js';
import attachmentsRoutes from './routes/attachments.js';
import documentsRoutes from './routes/documents.js';
import habitsRoutes from './routes/habits.js';
import profilesRoutes from './routes/profiles.js';
import medicationsRoutes from './routes/medications.js';
import dosesRoutes from './routes/doses.js';
import goalsRoutes from './routes/goals.js';
import digestRoutes from './routes/digest.js';
import patternsRoutes from './routes/patterns.js';
import ogRoutes from './routes/og.js';
import botRoutes from './routes/bot.js';
import aiRoutes from './routes/ai.js';
import searchRoutes from './routes/search.js';
import agentTokensRoutes from './routes/agent-tokens.js';
import apiPortalRoutes from './routes/api-portal.js';
import agentRoutes from './routes/agent.js';
// checkbox 103: stateless MCP server over the Streamable HTTP transport (disabled unless
// MCP_ENABLED=true); a single POST handler over the same scoped tokens + tool registry.
import mcpRoutes from './routes/mcp.js';
// checkbox 114: bounded worker drain (cron-job.org every minute; claim -> execute -> return).
import agentWorkerRoutes, { agentJobWorkerRoutes } from './routes/agent-worker.js';
// checkbox 130: operational health snapshot of the background AI (consumed by the degraded-state hook).
import agentHealthRoutes from './routes/agent-health.js';
// checkbox 115: the scheduling-loop tick + status (CRON_SECRET Bearer, idempotent single tick).
import agentSchedulerRoutes from './routes/agent-scheduler.js';
// checkbox 119: read/write control plane for agent jobs, workers and routines (admin session auth).
import adminAgentRoutes from './routes/admin/agent.js';
// checkbox 134: cross-entity tag vocabulary + links + the AND/OR smart filter (migration v58).
import tagsRoutes from './routes/tags.js';
// task 133: deterministic Ask panel (offline templates, no AI; auth-scoped).
import askRoutes from './routes/ask.js';
// tasks 126/127: decision cards + durable feedback policy memory (migration v63).
import decisionsRoutes from './routes/decisions.js';
// tasks 135/142: dedupe candidate scans (propose-only) + audit trail with TTL'd undo (v64).
import dedupeRoutes from './routes/dedupe.js';
import auditRoutes from './routes/audit.js';
// task 137: data-health report + one-click idempotent repairs (migration v65).
import dataHealthRoutes from './routes/data-health.js';
// v2.26: retention policy view + manual purge + digest archive list.
import retentionRoutes from './routes/retention.js';
// task 139: notification-channel repair checks/actions.
import channelRepairRoutes from './routes/channel-repair.js';
// tasks 140/141: recurring routine templates (migration v67).
import templatesRoutes from './routes/templates.js';
// task 144: inbound feed ingest (ICS/mail -> proposals; never silent writes) (migration v69).
import feedsRoutes from './routes/feeds.js';
// task 146: optional OCR extraction (disabled unless an engine is configured) (migration v70).
import ocrRoutes from './routes/ocr.js';
// task 148: read-only family share links (public GET + session-scoped management) (migration v70).
import shareRoutes from './routes/share.js';
// task 151: weather + air quality for the stored location (migration v71).
import weatherRoutes from './routes/weather.js';
// task 152: tracked parcels (migration v71).
import parcelsRoutes from './routes/parcels.js';
// task 143: bounded bulk actions (batch approve/reject; per-item results).
import bulkRoutes from './routes/bulk.js';
// task 147: print & export views (renders from existing events/contacts/logs).
import exportRoutes from './routes/export.js';
// task 149: WebDAV / S3 remote backup config + runs (migration v70).
import remoteBackupRoutes from './routes/remote-backup.js';
// task 138: migration self-check: recorded schema version vs the migrate.ts tail (session auth).
import migrationSelfcheckRoutes from './routes/migration-selfcheck.js';
// task 162: AI-off verification extension point (proves the AI layer is disabled).
import aiStatusRoutes from './routes/ai-status.js';
// task 141: deterministic smart defaults derived from history (no model calls).
import smartDefaultsRoutes from './routes/smart-defaults.js';
// tasks 153/154/155: attendance / child-elder care / pet care routes (migration v72).
import timesheetRoutes from './routes/timesheet.js';
import careRoutes from './routes/care.js';
import petsRoutes from './routes/pets.js';
// tasks 156/157/158: vehicle ledger / watch-read list / household lists (migration v73).
import vehiclesRoutes from './routes/vehicles.js';
import watchlistRoutes from './routes/watchlist.js';
import inventoryListRoutes from './routes/inventory-list.js';
// tasks 159/160: external calendar sync + single-owner collaboration invites (migration v74).
import calendarSyncRoutes from './routes/calendar-sync.js';
import collaborationRoutes from './routes/collaboration.js';
import { logStorageStartupStatus } from './services/storage.service.js';
import { ensureVercelReady, ensureAdminUser } from './vercel-init.js';
// task 161: field-level encryption migration (mirrors the Vercel cold-start bootstrap).
import { migrateFieldEncryption } from './services/field-encryption.service.js';

const log = createLogger('bootstrap');

// --- App setup (shared between local Docker and Vercel serverless) ---
const app = new Hono();

/**
 * The Telegram webhook is a machine-to-machine endpoint: Telegram sends no browser Origin,
 * Referer or X-Requested-With, and authenticates every request with its own
 * `X-Telegram-Bot-Api-Secret-Token` header (verified in routes/bot.ts). It therefore needs
 * the same explicit exemption from the zero-trust and CSRF middleware that `/api/webhook/*`
 * already has, and it must be mounted before those guards to keep the exemption in one place.
 */
const isTelegramWebhook = (c: { req: { method: string; path: string } }): boolean =>
  c.req.method === 'POST' && c.req.path === '/api/bot/telegram';

// v2.27 C-9：全局兜底错误处理——未捕获异常统一返回 {success,error} JSON 500
//（此前是 Hono 默认纯文本，前端拿到的是非 JSON 而直接报「请求失败」）。
app.onError((err, c) => {
  console.error('[unhandled]', c.req.method, c.req.path, err);
  return c.json({ success: false, error: '服务器内部错误，请稍后重试' }, 500);
});

app.use('*', async (c, next) => (isTelegramWebhook(c) ? next() : zeroTrustGuard(c, next)));
app.use('*', securityHeaders);
app.use('/api/*', httpsEnforcement);

const configuredOrigins = getConfiguredOrigins();

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return configuredOrigins[0] ?? 'http://localhost:5173';
    if (isAllowedOrigin(origin, undefined, configuredOrigins)) return origin;
    return null;
  },
  credentials: true,
}));
app.use('*', requestIdMiddleware);
const csrf = csrfProtection();
app.use('*', async (c, next) => (isTelegramWebhook(c) ? next() : csrf(c, next)));

// Vercel serverless: ensure DB migrations on cold start (skip health probes)
if (process.env.VERCEL) {
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/health' || path === '/health') {
      return next();
    }
    await ensureVercelReady();
    await next();
  });
}

// Rate limiting: targeted limits before general (login limit is on auth route itself)
const notifyRateLimit = rateLimit(10, 60 * 1000);
app.use('/api/channels/test', notifyRateLimit);
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'POST' && c.req.path === '/api/auth/login') {
    return next();
  }
  return apiRateLimit(c, next);
});

app.route('/api/auth', authRoutes);
app.route('/api/auth/webauthn', webauthnRoutes);
app.route('/api/events', eventRoutes);
app.route('/api/config', configRoutes);
app.route('/api/channels', channelsRoutes);
app.route('/api/stats', statsRoutes);
app.route('/api/backup', backupRoutes);
app.route('/api/calendar', calendarRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/cron', cronRoutes);
app.route('/api/data', dataRoutes);
app.route('/api/trigger-logs', triggerLogRoutes);
app.route('/api/greetings', greetingsRoutes);
app.route('/api/user', userRoutes);
app.route('/api/features', featuresRoutes);
app.route('/api/security', securityRoutes);
app.route('/api/calendar', calendarImportRoutes);
app.route('/api/calendar', googleCalendarRoutes);
app.route('/api/contacts', contactsRoutes);
app.route('/api/broadcast', broadcastRoutes);
app.route('/api/email-logs', emailLogsRoutes);
app.route('/api/webhook', webhookInboundRoutes);
app.route('/api/calendar', calendarPublicRoutes);
// checkbox 89: tokenised public ICS subscription feeds. Mounted under /api/... so the
// existing vercel.json SPA rewrite (owned by another lane) needs no change.
app.route('/api/public/ics', publicIcsRoutes);
app.route('/api/inbox', inboxRoutes);
app.route('/api/inbox', inboxPublicRoutes);
app.route('/api/cron-monitor', cronMonitorRoutes);
app.route('/api/webhook/resend', resendWebhookRoutes);
app.route('/api/conditional-rules', conditionalRulesRoutes);
app.route('/api/todos', todosRoutes);
app.route('/api/csp-report', cspReportRoutes);
app.route('/api/time', timeRoutes);
app.route('/api/expiry', expiryRoutes);
app.route('/api/inventory', inventoryRoutes);
app.route('/api/maintenance', maintenanceRoutes);
app.route('/api/attachments', attachmentsRoutes);
app.route('/api/documents', documentsRoutes);
app.route('/api/habits', habitsRoutes);
app.route('/api/profiles', profilesRoutes);
app.route('/api/medications', medicationsRoutes);
app.route('/api/doses', dosesRoutes);
app.route('/api/goals', goalsRoutes);
app.route('/api/digest', digestRoutes);
// checkbox 105: deterministic behavioural patterns (nightly miner, no LLM).
app.route('/api/patterns', patternsRoutes);
app.route('/api/og', ogRoutes);
// checkbox 91: Telegram bot webhook + webhook setup/status management.
app.route('/api/bot', botRoutes);
// checkbox 98: AI provider gateway status (disabled unless AI_* env vars are set).
app.route('/api/ai', aiRoutes);
// checkbox 106: search over the user's own data - pg_trgm by default (zero egress),
// opt-in pgvector semantic ranking behind EMBEDDINGS_ENABLED.
app.route('/api/search', searchRoutes);
// checkbox 101: scoped, revocable agent tokens + audit log (settings CRUD; raw shown once).
app.route('/api/agent-tokens', agentTokensRoutes);
// checkbox 114: the bounded worker drain. Mounted before `/api/agent` so its exact path is
// matched by this handler (not the agent sub-app's wildcard rate-limit middleware).
app.route('/api/agent/worker', agentWorkerRoutes);
// task 129: job lifecycle (heartbeat / complete / fail) for outbound workers (docs/WORKER.md).
// Same ordering rule as /api/agent/worker: registered before the /api/agent sub-app.
app.route('/api/agent/jobs', agentJobWorkerRoutes);
// checkbox 130: operational health snapshot (queue / worker / budget / degraded routines).
app.route('/api/agent/health', agentHealthRoutes);
// checkbox 115: the scheduling-loop tick + status (CRON_SECRET Bearer).
app.route('/api/agent/scheduler', agentSchedulerRoutes);
// checkbox 102: agent action API (registry, scoped execution, two-phase confirmation).
app.route('/api/agent', agentRoutes);
// checkbox 103: stateless MCP server (Streamable HTTP) over the same registry + scoped tokens.
app.route('/api/mcp', mcpRoutes);
// v2.30 方向 B: 对外 REST API（/api/v1/*，tmt_ token 鉴权，与 MCP 同源）。
app.route('/api/v1', apiPortalRoutes);
// checkbox 119: the agent control-plane API (jobs, workers, routines; session/admin auth only).
app.route('/api/admin/agent', adminAgentRoutes);
// task 138: migration self-check (recorded schema version vs the migrate.ts tail).
app.route('/api/admin/migration-selfcheck', migrationSelfcheckRoutes);
// checkbox 134: tags across events/contacts/documents/expiry/inventory/maintenance/habits/goals.
app.route('/api/tags', tagsRoutes);
// task 133: the deterministic Ask panel (offline templates; auth-scoped).
app.route('/api/ask', askRoutes);
// tasks 126/127: decision cards + durable feedback memory.
app.route('/api/decisions', decisionsRoutes);
// tasks 135/142: dedupe candidate scans + destructive-change audit / TTL'd undo.
app.route('/api/dedupe', dedupeRoutes);
app.route('/api/audit', auditRoutes);
// task 137: data-health report + one-click idempotent repairs.
app.route('/api/data-health', dataHealthRoutes);
// v2.26: retention policy view + manual purge + digest archive list.
app.route('/api/retention', retentionRoutes);
// task 139: notification-channel repair checks / actions.
app.route('/api/channel-repair', channelRepairRoutes);
// tasks 140/141: recurring routine templates.
app.route('/api/templates', templatesRoutes);
// task 144: inbound feed ingest (ICS / mail -> proposals).
app.route('/api/feeds', feedsRoutes);
// task 146: optional OCR extraction (disabled unless an engine is configured).
app.route('/api/ocr', ocrRoutes);
// task 148: read-only family share links (public GET; management requires a session).
app.route('/api/share', shareRoutes);
// task 151: weather + air quality for the stored location.
app.route('/api/weather', weatherRoutes);
// task 152: tracked parcels.
app.route('/api/parcels', parcelsRoutes);
// task 143: bounded bulk actions.
app.route('/api/bulk', bulkRoutes);
// task 147: print & export.
app.route('/api/export', exportRoutes);
// task 149: remote backup target + runs.
app.route('/api/remote-backup', remoteBackupRoutes);
// task 162: AI-off verification.
app.route('/api/ai-status', aiStatusRoutes);
// task 141: smart defaults from history.
app.route('/api/smart-defaults', smartDefaultsRoutes);
// tasks 153/154/155: attendance, care and pets.
app.route('/api/timesheet', timesheetRoutes);
app.route('/api/care', careRoutes);
app.route('/api/pets', petsRoutes);
// tasks 156/157/158: vehicles, watch/read list and household lists.
app.route('/api/vehicles', vehiclesRoutes);
app.route('/api/watchlist', watchlistRoutes);
app.route('/api/inventory-list', inventoryListRoutes);
// tasks 159/160: two-way calendar sync and family collaboration.
app.route('/api/calendar-sync', calendarSyncRoutes);
app.route('/api/collaboration', collaborationRoutes);
// todo 88: also expose the canonical `/share/:token` server-rendered meta document at the app
// root so it resolves locally and in tests. On Vercel this path is owned by the SPA rewrite in
// vercel.json (`/((?!api/|.*\\..*).*)` -> /index.html), so the OG image (`/api/og/image/:token`)
// is the production-reachable dynamic asset — the tags themselves are client-injected there.
app.route('/', ogRoutes);

app.get('/health', (c) => c.json({ status: 'ok', platform: process.env.VERCEL ? 'vercel' : 'local' }));
app.get('/api/health', async (c) => {
  const detailed = c.req.query('detailed') === '1' && c.req.header('x-health-token') === process.env.HEALTH_DETAIL_TOKEN;
  const checks: Record<string, boolean | string> = {
    platform: process.env.VERCEL ? 'vercel' : 'local',
    // v2.28：版本从 package.json 注入（原硬编码 2.16.0 已与发布脱节）
    version: APP_VERSION,
    database: false,
    // v2.30：拆成三维——只看 Secret 时，SiteKey 丢失会让面板全绿而登录页验证
    // 消失、登录被拒（生产事故复盘）。`turnstile` 现在只在"完整可用"时为 true。
    turnstile: !!getTurnstileSiteKey() && isTurnstileEnabled(),
    turnstileSiteKey: !!getTurnstileSiteKey(),
    turnstileSecret: isTurnstileEnabled(),
  };
  if (process.env.VERCEL) {
    const fnRegion = process.env.VERCEL_REGION || 'unknown';
    checks.functionRegion = fnRegion;
    checks.functionRegionOptimalForCn = isPreferredCnVercelRegion(fnRegion);
  }
  if (detailed && process.env.HEALTH_DETAIL_TOKEN) {
    checks.commit = process.env.VERCEL_GIT_COMMIT_SHA || 'local';
    checks.databaseUrl = !!process.env.DATABASE_URL;
    checks.jwtSecret = !!process.env.JWT_SECRET;
    checks.masterKey = !!process.env.MASTER_KEY;
    checks.cronSecret = !!getCronSecret();
    checks.databaseRegionHint = inferDatabaseRegionHint(process.env.DATABASE_URL);
  }
  if (!process.env.DATABASE_URL) {
    checks.database = false;
    checks.error = 'DATABASE_URL not configured';
    return c.json({ status: 'degraded', checks }, 503);
  }
  try {
    await query('SELECT 1');
    checks.database = true;

    const cachedTime = getLastTimeSyncResult(DEFAULT_SYNC_TIMEZONE);
    checks.timeDriftMs = String(cachedTime?.drift ?? 0);
    checks.clockOffsetMs = String(getClockOffsetMs(DEFAULT_SYNC_TIMEZONE));
    checks.timeSource = cachedTime?.source ?? 'system';
    scheduleTimeSync(DEFAULT_SYNC_TIMEZONE);

    // v2.26: 读有界的 cron_job_status（每 job 一行 upsert）——旧查询在 26 万行的
    // cron_execution_logs 上全表排序，是 /api/health 的慢路径。
    const lastCron = await query(
      `SELECT job_name, last_status AS status, updated_at AS executed_at
       FROM cron_job_status ORDER BY updated_at DESC LIMIT 1`,
    ).catch(() => ({ rows: [] }));
    if (detailed && process.env.HEALTH_DETAIL_TOKEN && lastCron.rows[0]) {
      checks.lastCronJob = lastCron.rows[0].job_name;
      checks.lastCronStatus = lastCron.rows[0].status;
      checks.lastCronAt = lastCron.rows[0].executed_at;
    }

    if (detailed && process.env.HEALTH_DETAIL_TOKEN) {
      const queueDepth = await query(
        `SELECT COUNT(*)::int AS pending FROM notification_queue WHERE status = 'pending'`,
      ).catch(() => ({ rows: [{ pending: 0 }] }));
      const successRate = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'success')::int AS success
         FROM event_trigger_logs WHERE created_at > NOW() - INTERVAL '24 hours'`,
      ).catch(() => ({ rows: [{ total: 0, success: 0 }] }));
      checks.queueDepth = String(queueDepth.rows[0]?.pending ?? 0);
      const total = successRate.rows[0]?.total ?? 0;
      const success = successRate.rows[0]?.success ?? 0;
      checks.successRate24h = String(total > 0 ? Math.round((success / total) * 100) : 100);
    }

    return c.json({ status: 'ok', checks });
  } catch (error) {
    checks.database = false;
    checks.error = error instanceof Error ? error.message : 'Database unavailable';
    return c.json({ status: 'degraded', checks }, 503);
  }
});

// Serve frontend static files (local/Docker only)
if (!process.env.VERCEL) {
  app.use('/*', serveStatic({ root: './frontend/dist' }));
  app.get('*', serveStatic({ path: './frontend/dist/index.html' }));
}

async function bootstrap() {

  // 0. 初始化密钥（首次启动自动生成，后续启动从文件读取）
  log.info('Initializing secret keys...');
  initSecretKeys();
  log.info('Secret keys ready');

  // 0.5 附件存储模式：本地回退响亮告警；生产缺 token 时附件将拒绝服务（不写盘）
  logStorageStartupStatus();

  // 1. 等待数据库就绪
  log.info('等待数据库初始化...');
  await waitForDb();
  log.info('数据库就绪');

  // 2. 执行 schema 迁移
  await runMigrations();

  // 2.5 迁移旧密钥加密的数据到新密钥
  await migrateEncryptionKey();

  // 2.6 字段级加密迁移（task 161；与 Vercel 冷启动 vercel-init.ts 保持一致）
  await migrateFieldEncryption();

  // 3. 初始化管理员用户（与 Vercel 冷启动共用同一个实现 vercel-init.ts）
  const userResult = await query('SELECT id FROM users LIMIT 1');
  if (userResult.rows.length === 0) {
    await ensureAdminUser();
  } else {
    log.info('数据库已初始化，已存在用户');
  }

  const port = parseInt(process.env.PORT || '3000');

  // 5. 启动定时任务 (local/Docker only; Vercel uses Cron Jobs instead)
  // 直接指向 stub，而不是靠 Vercel 构建期把 `scheduler.js` 改写过去：
  // 那个改写只发生在 `pnpm build:vercel-api`，本地 `pnpm dev:backend` 没有它，
  // 于是本地启动直接 ERR_MODULE_NOT_FOUND（`scheduler.ts` 已在 Vercel 迁移中删除）。
  // 本仓库是 Vercel 优先、定时任务由 `/api/cron/*` + 外部 Cron 触发，没有常驻调度器，
  // 所以本地也用同一个 no-op stub 才是与生产一致的行为。
  if (!process.env.VERCEL) {
    const { startScheduler } = await import('./queue/scheduler.vercel-stub.js');
    startScheduler().catch((err: unknown) => log.error(err, 'Scheduler failed to start'));
  }

  // 6. 优雅关闭
  process.on('SIGTERM', async () => {
    log.info('SIGTERM received, shutting down...');
    if (!process.env.VERCEL) {
      const { stopScheduler } = await import('./queue/scheduler.vercel-stub.js');
      await stopScheduler();
    }
    const { gracefulShutdown } = await import('./db/index.js');
    gracefulShutdown();
    process.exit(0);
  });

  log.info({ port }, 'Server running');
  serve({ fetch: app.fetch, port });
}

// v2.30 硬化（全链路实测踩坑）：渠道发送链出过一次 fromPromise unhandledRejection
// 直接击穿本地进程。进程级兜底只记日志不退出——单条通知的意外拒绝不该拖死
// 正在服务的其他请求；真正的缺陷仍要沿日志里的 event/stack 修。
process.on('unhandledRejection', (reason) => {
  log.error({ event: 'process.unhandled_rejection', err: reason }, 'Unhandled rejection (logged, process kept alive)');
});
process.on('uncaughtException', (err) => {
  log.fatal(err, 'Uncaught exception (logged, process kept alive)');
});

// Local/Docker: bootstrap the full app (DB init, scheduler, HTTP server)
if (!process.env.VERCEL) {
  bootstrap().catch((err) => {
    log.fatal(err, '启动失败');
    process.exit(1);
  });
}

// Vercel: export the Hono app as default for serverless Functions
export default app;
