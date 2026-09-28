import { query } from '../db/index.js';
import { toYmdString } from '@timemark/shared/event-schedule';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `events` 的 DATE 列（date / birth_date / next_occurrence）。pg 把 DATE 解析为
 * 「本地午夜」的 Date；若直接 JSON.stringify，会被强制成 UTC ISO 瞬时，read-back
 * 时用字符串切片取日期会在正偏移时区回退一天（今天的事件在缓存命中时不触发）。
 * 写缓存前统一存成纯 `YYYY-MM-DD`，与读写所在时区无关。
 */
function normalizeEventDates(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    date: toYmdString(row.date),
    birth_date: toYmdString(row.birth_date),
    next_occurrence: toYmdString(row.next_occurrence),
  };
}

/** Cache all reminder-eligible events per user (cron resolves yearly occurrence in code). */
export async function refreshUserEventCache(userId: number): Promise<void> {
  const result = await query(
    `SELECT * FROM events
     WHERE user_id = $1
       AND (
         reminder_config IS NULL
         OR reminder_config::jsonb->>'enabled' IS DISTINCT FROM 'false'
       )`,
    [userId],
  );
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
  await query(
    `INSERT INTO event_reminder_cache (user_id, payload, expires_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (user_id) DO UPDATE SET payload = $2::jsonb, expires_at = $3, updated_at = CURRENT_TIMESTAMP`,
    [userId, JSON.stringify(result.rows.map(normalizeEventDates)), expiresAt],
  );
}

export async function getCachedEventsForUser(userId: number): Promise<unknown[] | null> {
  const result = await query(
    `SELECT payload FROM event_reminder_cache
     WHERE user_id = $1 AND expires_at > NOW()`,
    [userId],
  );
  if (!result.rows[0]?.payload) return null;
  const payload = result.rows[0].payload;
  return Array.isArray(payload) ? payload : null;
}

export async function purgeExpiredEventCache(): Promise<number> {
  const result = await query(`DELETE FROM event_reminder_cache WHERE expires_at <= NOW()`);
  return result.rowCount ?? 0;
}
