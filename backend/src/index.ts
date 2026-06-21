import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { requestIdMiddleware } from './middleware/request-id.js';
import { securityHeaders } from './middleware/security-headers.js';
import { csrfProtection } from './middleware/csrf.js';
import { authRateLimit, apiRateLimit, rateLimit } from './middleware/rate-limit.js';
import 'dotenv/config';
import { createLogger } from './utils/logger.js';
import { waitForDb, query } from './db/index.js';
import { runMigrations, migrateEncryptionKey } from './db/migrate.js';
import { hashPassword } from './utils/password.js';
import { initSecretKeys } from './utils/secrets.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import configRoutes from './routes/config.js';
import channelsRoutes from './routes/channels.js';
import statsRoutes from './routes/stats.js';
import backupRoutes from './routes/backup.js';
import calendarRoutes from './routes/calendar.js';
import pushRoutes from './routes/push.js';
import cronRoutes from './routes/cron.js';

const log = createLogger('bootstrap');

// --- App setup (shared between local Docker and Vercel serverless) ---
const app = new Hono();

app.use('*', honoLogger());
app.use('*', securityHeaders);

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

// Include Vercel deployment URL when running on Vercel
if (process.env.VERCEL_URL) {
  corsOrigins.push(`https://${process.env.VERCEL_URL}`);
}

app.use('*', cors({
  origin: corsOrigins,
  credentials: true,
}));
app.use('*', requestIdMiddleware);
app.use('*', csrfProtection());

// Rate limiting: specific limits before general
const notifyRateLimit = rateLimit(10, 60 * 1000);
app.use('/api/auth/*', authRateLimit);
app.use('/api/channels/test', notifyRateLimit);
app.use('/api/*', apiRateLimit);

app.route('/api/auth', authRoutes);
app.route('/api/events', eventRoutes);
app.route('/api/config', configRoutes);
app.route('/api/channels', channelsRoutes);
app.route('/api/stats', statsRoutes);
app.route('/api/backup', backupRoutes);
app.route('/api/calendar', calendarRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/cron', cronRoutes);

app.get('/health', (c) => c.json({ status: 'ok' }));

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
    const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
    const passwordHash = await hashPassword(password);

    await query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
      [username, passwordHash]
    );

    console.log(`✅ 默认用户已创建 (用户名: ${username}, 密码: ${password})`);
    console.log('⚠️  请登录后立即修改默认密码！');

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
