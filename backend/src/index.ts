import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import 'dotenv/config';
import { waitForDb, query } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { hashPassword } from './utils/password.js';
import { randomUUID } from 'crypto';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import configRoutes from './routes/config.js';
import channelsRoutes from './routes/channels.js';
import { startScheduler, stopScheduler } from './queue/scheduler.js';

async function bootstrap() {
  // 0. 环境变量提示（不阻塞启动）
  if (!process.env.MASTER_KEY) {
    console.warn('⚠️ MASTER_KEY 未设置，使用默认密钥。建议生产环境设置自定义密钥');
  }

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
    const passwordHash = hashPassword(password);
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    await query(
      'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
      [id, username, passwordHash, createdAt]
    );

    console.log('✅ 创建默认用户成功');
    console.log(`   用户名: ${username}`);
    if (password === 'TimeMark@2026') {
      console.warn('⚠️  使用默认密码！请登录后立即修改密码并启用2FA！');
    }
  } else {
    console.log('✅ 数据库已初始化，已存在用户');
  }

  // 4. 创建 Hono 应用
  const app = new Hono();

  app.use('*', logger());
  app.use('*', cors({
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    credentials: true,
  }));

  app.route('/api/auth', authRoutes);
  app.route('/api/events', eventRoutes);
  app.route('/api/config', configRoutes);
  app.route('/api/channels', channelsRoutes);

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
    process.exit(0);
  });

  console.log(`🚀 Server running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
}

bootstrap().catch((err) => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});