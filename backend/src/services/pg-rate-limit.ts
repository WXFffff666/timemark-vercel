import { query } from '../db/index.js';

/** PostgreSQL-backed fixed-window rate limiter (serverless-safe). */
export async function checkPgRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  // v2.30 修复：旧 SQL 只引用 $1/$3，$2（maxRequests）传了但没用 → PG 42P18
  // "could not determine data type of parameter $2" → 每次调用都抛错，
  // 中间件静默降级成单实例内存限流（serverless 上形同虚设）。maxRequests 本来
  // 就只在 JS 侧使用，SQL 里不需要它；窗口改用 make_interval 并显式定型。
  const result = await query(
    `INSERT INTO rate_limits (key, count, window_start)
     VALUES ($1::text, 1, NOW())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE
         WHEN rate_limits.window_start + make_interval(secs => $2::int) <= NOW() THEN 1
         ELSE rate_limits.count + 1
       END,
       window_start = CASE
         WHEN rate_limits.window_start + make_interval(secs => $2::int) <= NOW() THEN NOW()
         ELSE rate_limits.window_start
       END
     RETURNING count, EXTRACT(EPOCH FROM window_start)::bigint AS window_epoch`,
    [key, windowSeconds],
  );

  // window_start 是 naive timestamp（DB 时区可能 ≠ Node 时区），直接 parse 会偏移
  // 数小时（v2.30 全链路实测发现 8h 偏差）——epoch 在 SQL 端提取，天然无时区。
  // 异常行（缺列/空结果）退化为"从现在起算新窗口"，绝不让 NaN 流入响应。
  const row = result.rows[0] as { count?: unknown; window_epoch?: unknown } | undefined;
  const count = Number.isFinite(Number(row?.count)) ? Number(row?.count) : 1;
  const windowEpochMs = Number(row?.window_epoch) * 1000;
  const resetAt = Number.isFinite(windowEpochMs)
    ? windowEpochMs + windowSeconds * 1000
    : Date.now() + windowSeconds * 1000;

  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    resetAt,
  };
}
