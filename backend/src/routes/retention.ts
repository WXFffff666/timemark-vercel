import { Hono } from 'hono';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { RETENTION_DAYS, purgeExpiredLogs } from '../services/retention.service.js';

/**
 * v2.26 批次 B：数据管理卡 API（设置页「安全与数据」）。
 *
 *   GET  /api/retention           -> 保留策略 + AI 月报归档列表 + nightly 清理状态
 *   POST /api/retention/purge-now -> 手动触发一次全量清理（与 nightly 同一代码路径）
 *
 * 保留策略是全实例级（日志表无 user_id 维度的部分占多数），purge-now 因此不按
 * 用户隔离：登录用户触发的是整库过期行清理，与 cron 每晚跑的完全一致。
 */
const retention = new Hono<{ Variables: { user: User } }>();
retention.use('*', authMiddleware);

type ArchiveRow = {
  id: number;
  period: string;
  period_start: string;
  period_end: string;
  narrative_preview: string | null;
  stats: Record<string, unknown> | null;
  created_at: string;
};

retention.get('/', async (c) => {
  const userId = Number(c.get('user').id);

  let archives: ArchiveRow[] = [];
  try {
    const result = await query(
      `SELECT id, period, period_start, period_end, left(narrative_md, 280) AS narrative_preview, stats_json, created_at
       FROM digest_archive WHERE user_id = $1 ORDER BY period_start DESC LIMIT 24`,
      [userId],
    );
    archives = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      let stats: Record<string, unknown> | null = null;
      if (typeof r.stats_json === 'string') {
        try {
          stats = JSON.parse(r.stats_json) as Record<string, unknown>;
        } catch {
          stats = null;
        }
      }
      return {
        id: Number(r.id),
        period: String(r.period),
        period_start: String(r.period_start),
        period_end: String(r.period_end),
        narrative_preview: (r.narrative_preview as string | null) ?? null,
        stats,
        created_at: String(r.created_at),
      };
    });
  } catch {
    // digest_archive 是 v80 新表：老库未迁移时归档列表返回空，不阻塞策略展示。
  }

  let lastPurge: { status: string; updatedAt: string } | null = null;
  try {
    const result = await query(
      `SELECT last_status, updated_at FROM cron_job_status WHERE job_name = 'daily-maintenance' LIMIT 1`,
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row) {
      lastPurge = { status: String(row.last_status), updatedAt: String(row.updated_at) };
    }
  } catch {
    // cron_job_status 不存在（老库）时忽略。
  }

  return c.json({ success: true, data: { policy: RETENTION_DAYS, archives, lastPurge } });
});

retention.post('/purge-now', async (c) => {
  try {
    const result = await purgeExpiredLogs();
    return c.json({ success: true, data: result });
  } catch (error) {
    return c.json(
      { success: false, error: error instanceof Error ? error.message : '清理失败' },
      500,
    );
  }
});

export default retention;
