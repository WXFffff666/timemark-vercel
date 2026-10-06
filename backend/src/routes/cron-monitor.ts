import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';
import { createLogger } from '../utils/logger.js';
import { getCronSecret } from '../utils/heartbeat.js';

const log = createLogger('cron-monitor');
const cronMonitor = new Hono<{ Variables: { user: User } }>();
cronMonitor.use('*', authMiddleware);

cronMonitor.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
  const result = await query(
    `SELECT job_name, status, duration_ms, result_summary, error_message, executed_at
     FROM cron_execution_logs ORDER BY executed_at DESC LIMIT $1`,
    [limit],
  );
  // v2.26: lastByJob 改读有界的 cron_job_status（每 job 一行 upsert）——
  // 旧 DISTINCT ON 全表扫描随 cron_execution_logs 增长而变慢；失败明细仍在 recent。
  const lastByJob = await query(
    `SELECT job_name, last_status AS status, updated_at AS executed_at, last_summary AS result_summary
     FROM cron_job_status ORDER BY job_name`,
  );
  // v2.28：失败原因按信任级放开 —— 会话用户（机主本人）全显；API key 访问需
  // admin scope，否则维持 '[redacted]'（error_message 可能含内部 URL/上游细节）。
  // Variables 泛型未声明 apiScopes（仅 API key 中间件写入），经 unknown 双转读取
  const apiScopes = c.get('apiScopes' as unknown as 'user') as unknown as string[] | undefined;
  const fullTrust = !Array.isArray(apiScopes) || apiScopes.includes('admin');
  const sanitize = (row: Record<string, unknown>) => ({
    ...row,
    error_message: row.error_message
      ? (fullTrust ? row.error_message : '[redacted]')
      : null,
    result_summary: row.result_summary ?? null,
  });
  return c.json({
    success: true,
    data: {
      recent: result.rows.map(sanitize),
      lastByJob: lastByJob.rows.map(sanitize),
    },
  });
});

/**
 * v2.30：从监控页"立即运行"任务。仅放开两条安全、幂等的任务（提醒检查、
 * 队列重试）——重活（daily-maintenance/channel-health）仍走 CRON_SECRET 通道，
 * 避免被误点后长时间占用函数。仅机主本人（fullTrust）可用。
 */
const RUNNABLE_JOBS: Record<string, () => Promise<{ summary: string }>> = {
  'reminder-check': async () => {
    const { sendReminders } = await import('../jobs/tasks.js');
    await sendReminders();
    return { summary: '手动触发提醒检查完成' };
  },
  'retry-notifications': async () => {
    const { processNotificationRetries } = await import('../services/notification-retry.service.js');
    const r = await processNotificationRetries();
    return { summary: `手动重试完成：处理 ${r.processed} 条，成功 ${r.succeeded} 条` };
  },
};

// 简单进程内限速：每任务每分钟最多 1 次手动触发（防手抖连点）
const lastRunAt = new Map<string, number>();

cronMonitor.post('/run/:job', async (c) => {
  if (!getCronSecret()) {
    return c.json({ success: false, error: '未配置 CRON_SECRET，无法手动触发' }, 400);
  }
  const apiScopes = c.get('apiScopes' as unknown as 'user') as unknown as string[] | undefined;
  const fullTrust = !Array.isArray(apiScopes) || apiScopes.includes('admin');
  if (!fullTrust) {
    return c.json({ success: false, error: '仅机主可手动触发任务' }, 403);
  }
  const job = c.req.param('job');
  const runner = RUNNABLE_JOBS[job];
  if (!runner) {
    return c.json({ success: false, error: `任务 ${job} 不支持手动触发` }, 404);
  }
  const last = lastRunAt.get(job) ?? 0;
  if (Date.now() - last < 60_000) {
    return c.json({ success: false, error: '该任务刚触发过，请稍后再试' }, 429);
  }
  lastRunAt.set(job, Date.now());
  const started = Date.now();
  try {
    const { summary } = await runner();
    return c.json({ success: true, data: { job, summary, durationMs: Date.now() - started } });
  } catch (error) {
    log.error({ event: 'cron.manual_run_failed', job, err: error }, '手动触发任务失败');
    return c.json(
      { success: false, error: error instanceof Error ? error.message : '任务执行失败' },
      500,
    );
  }
});

export default cronMonitor;
