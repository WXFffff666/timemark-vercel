import { query } from '../db/index.js';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache upcoming events per user (7-day window) to reduce cron DB load. */
export async function refreshUserEventCache(userId: number): Promise<void> {
  const result = await query(
    `SELECT * FROM events
     WHERE user_id = $1
       AND date >= CURRENT_DATE - INTERVAL '1 day'
       AND date <= CURRENT_DATE + INTERVAL '7 days'`,
    [userId],
  );
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
  await query(
    `INSERT INTO event_reminder_cache (user_id, payload, expires_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (user_id) DO UPDATE SET payload = $2::jsonb, expires_at = $3, updated_at = CURRENT_TIMESTAMP`,
    [userId, JSON.stringify(result.rows), expiresAt],
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
