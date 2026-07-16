import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { requestIdMiddleware } from './middleware/request-id.js';
import { securityHeaders } from './middleware/security-headers.js';
import { csrfProtection } from './middleware/csrf.js';
import { loginRateLimit, apiRateLimit, rateLimit } from './middleware/rate-limit.js';
import { getConfiguredOrigins, isAllowedOrigin } from './utils/allowed-origins.js';
import 'dotenv/config';
import { createLogger } from './utils/logger.js';
import { waitForDb, query } from './db/index.js';
import { runMigrations, migrateEncryptionKey } from './db/migrate.js';
import { hashPassword } from './utils/password.js';
import { initSecretKeys } from './utils/secrets.js';
import { isTurnstileEnabled } from './utils/turnstile.js';
import { getCronSecret } from './utils/heartbeat.js';
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
import inboxRoutes from './routes/inbox.js';
import inboxPublicRoutes from './routes/inbox-public.js';
import cronMonitorRoutes from './routes/cron-monitor.js';
import resendWebhookRoutes from './routes/resend-webhook.js';
import conditionalRulesRoutes from './routes/conditional-rules.js';
import { ensureVercelReady } from './vercel-init.js';

const log = createLogger('bootstrap');

// --- App setup (shared between local Docker and Vercel serverless) ---
const app = new Hono();

app.use('*', honoLogger());
app.use('*', securityHeaders);

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
app.use('*', csrfProtection());

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
app.use('/api/*', apiRateLimit);

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
app.route('/api/inbox', inboxRoutes);
app.route('/api/inbox', inboxPublicRoutes);
app.route('/api/cron-monitor', cronMonitorRoutes);
app.route('/api/webhook/resend', resendWebhookRoutes);
app.route('/api/conditional-rules', conditionalRulesRoutes);

app.get('/health', (c) => c.json({ status: 'ok', platform: process.env.VERCEL ? 'vercel' : 'local' }));
app.get('/api/health', async (c) => {
  const detailed = c.req.query('detailed') === '1' && c.req.header('x-health-token') === process.env.HEALTH_DETAIL_TOKEN;
  const checks: Record<string, boolean | string> = {
    platform: process.env.VERCEL ? 'vercel' : 'local',
    version: '2.14.0',
    database: false,
    turnstile: isTurnstileEnabled(),
  };
  if (detailed && process.env.HEALTH_DETAIL_TOKEN) {
    checks.commit = process.env.VERCEL_GIT_COMMIT_SHA || 'local';
    checks.databaseUrl = !!process.env.DATABASE_URL;
    checks.jwtSecret = !!process.env.JWT_SECRET;
    checks.masterKey = !!process.env.MASTER_KEY;
    checks.cronSecret = !!getCronSecret();
  }
  if (!process.env.DATABASE_URL) {
    checks.database = false;
    checks.error = 'DATABASE_URL not configured';
    return c.json({ status: 'degraded', checks }, 503);
  }
  try {
    await query('SELECT 1');
    checks.database = true;

    const lastCron = await query(
      `SELECT job_name, status, executed_at FROM cron_execution_logs ORDER BY executed_at DESC LIMIT 1`,
    ).catch(() => ({ rows: [] }));
    if (lastCron.rows[0]) {
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
  const secrets = initSecretKeys();
  log.info('Secret keys ready');

  // 1. 等待数据库就绪
  log.info('等待数据库初始化...');
  await waitForDb();
  log.info('数据库就绪');

  // 2. 执行 schema 迁移
  await runMigrations();

  // 2.5 迁移旧密钥加密的数据到新密钥
  await migrateEncryptionKey();

  // 3. 初始化管理员用户
  const userResult = await query('SELECT id FROM users LIMIT 1');
  if (userResult.rows.length === 0) {
    const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
    const password = process.env.DEFAULT_ADMIN_PASSWORD || 'TimeMark@2026';
    const passwordHash = await hashPassword(password);

    await query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
      [username, passwordHash]
    );

    log.info({ username }, 'Default admin user created — change password on first login');

  } else {
    log.info('数据库已初始化，已存在用户');
  }

  const port = parseInt(process.env.PORT || '3000');

  // 5. 启动定时任务 (local/Docker only; Vercel uses Cron Jobs instead)
  if (!process.env.VERCEL) {
    // @ts-expect-error - scheduler.ts deleted in Vercel migration; guarded by !process.env.VERCEL
    const { startScheduler } = await import('./queue/scheduler.js');
    startScheduler().catch((err: unknown) => log.error(err, 'Scheduler failed to start'));
  }

  // 6. 优雅关闭
  process.on('SIGTERM', async () => {
    log.info('SIGTERM received, shutting down...');
    if (!process.env.VERCEL) {
      // @ts-expect-error - scheduler.ts deleted in Vercel migration; guarded by !process.env.VERCEL
      const { stopScheduler } = await import('./queue/scheduler.js');
      await stopScheduler();
    }
    const { gracefulShutdown } = await import('./db/index.js');
    gracefulShutdown();
    process.exit(0);
  });

  log.info({ port }, 'Server running');
  serve({ fetch: app.fetch, port });
}

// Local/Docker: bootstrap the full app (DB init, scheduler, HTTP server)
if (!process.env.VERCEL) {
  bootstrap().catch((err) => {
    log.fatal(err, '启动失败');
    process.exit(1);
  });
}

// Vercel: export the Hono app as default for serverless Functions
export default app;
