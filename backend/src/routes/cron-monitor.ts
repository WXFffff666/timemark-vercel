import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';

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
  // v2.28：本端点仅限 cron-secret/admin 持有者访问（路由层已有闸），失败原因
  // 对操作者放开——'[redacted]' 让 cron 失败永远无法排障。
  const sanitize = (row: Record<string, unknown>) => ({
    ...row,
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

export default cronMonitor;
