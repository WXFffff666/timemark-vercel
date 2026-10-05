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

export default cronMonitor;
