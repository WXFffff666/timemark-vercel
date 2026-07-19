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
  const lastByJob = await query(
    `SELECT DISTINCT ON (job_name) job_name, status, executed_at, result_summary
     FROM cron_execution_logs ORDER BY job_name, executed_at DESC`,
  );
  const sanitize = (row: Record<string, unknown>) => ({
    ...row,
    error_message: row.error_message ? '[redacted]' : null,
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
