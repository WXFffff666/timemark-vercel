import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import 'dotenv/config';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import { startScheduler, stopScheduler } from './queue/scheduler.js';
import './queue/processors.js';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));

app.route('/api/auth', authRoutes);
app.route('/api/events', eventRoutes);

app.get('/health', (c) => c.json({ status: 'ok' }));

const port = parseInt(process.env.PORT || '3000');

if (process.env.NODE_ENV === 'production') {
  startScheduler().catch(console.error);
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await stopScheduler();
  process.exit(0);
});

console.log(`🚀 Server running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
