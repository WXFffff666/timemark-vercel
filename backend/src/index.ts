import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { requestIdMiddleware } from './middleware/request-id.js';
import { csrfProtection } from './middleware/csrf.js';
import 'dotenv/config';
import { waitForDb, query } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { hashPassword } from './utils/password.js';
import { initSecretKeys } from './utils/secrets.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import configRoutes from './routes/config.js';
import channelsRoutes from './routes/channels.js';
import statsRoutes from './routes/stats.js';
import backupRoutes from './routes/backup.js';
import calendarRoutes from './routes/calendar.js';
import { startScheduler, stopScheduler } from './queue/scheduler.js';

async function bootstrap() {

  // 0. 初始化密钥（首次启动自动生成，后续启动从文件读取）
  console.log('🔐 Initializing secret keys...');
  const secrets = initSecretKeys();
  console.log('✅ Secret keys ready');

  // 1. 等待数据库就绪
  console.log('⏳ 等待数据库初始化...');
  await waitForDb();
  console.log('✅ 数据库就绪');

  // 2. 执行 schema 迁移
  await runMigrations();

  // 3. 初始化管理员用户
  const userResult = await query('SELECT id FROM users LIMIT 1');
  if (userResult.rows.length === 0) {
    const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
    const password = process.env.DEFAULT_ADMIN_PASSWORD || 'TimeMark@2026';
    const passwordHash = await hashPassword(password);

    await query(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, passwordHash]
    );

    console.log(`✅ 默认用户已创建 (${username})`);

  } else {
    console.log('✅ 数据库已初始化，已存在用户');
  }

  // 4. 创建 Hono 应用
  const app = new Hono();

  app.use('*', logger());
  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:3000'];
  app.use('*', cors({
    origin: corsOrigins,
    credentials: true,
  }));
  app.use('*', requestIdMiddleware);
  app.use('*', csrfProtection());

  app.route('/api/auth', authRoutes);
  app.route('/api/events', eventRoutes);
  app.route('/api/config', configRoutes);
  app.route('/api/channels', channelsRoutes);
  app.route('/api/stats', statsRoutes);
  app.route('/api/backup', backupRoutes);
  app.route('/api/calendar', calendarRoutes);

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Serve frontend static files
  app.use('/*', serveStatic({ root: './frontend/dist' }));
  app.get('*', serveStatic({ path: './frontend/dist/index.html' }));

  const port = parseInt(process.env.PORT || '3000');

  // 5. 启动定时任务
  startScheduler().catch(console.error);

  // 6. 优雅关闭
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down...');
    await stopScheduler();
    const { gracefulShutdown } = await import('./db/index.js');
    gracefulShutdown();
    process.exit(0);
  });

  console.log(`🚀 Server running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
}

bootstrap().catch((err) => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});