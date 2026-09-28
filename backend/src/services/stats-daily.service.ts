import { query } from '../db/index.js';

/**
 * 10-char prefix invariant (migration 51): `event_trigger_logs.trigger_date` is TEXT whose
 * first 10 characters are ALWAYS the calendar day `YYYY-MM-DD` - legacy rows are exactly
 * 10 chars, new dedup tokens append `#d<n>#tHH:mm`. The column must never be compared to
 * a DATE (`text = date` -> 42883) nor cast to date (a `::date` cast -> 22007 on any token
 * row). Compare `LEFT(trigger_date, 10)` against an explicit ymd instead.
 */
function yesterdayYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 聚合前一日统计到 stats_daily */
export async function aggregateDailyStats(): Promise<number> {
  const statDate = yesterdayYmd();
  const result = await query(
    `INSERT INTO stats_daily (user_id, stat_date, events_count, triggers_total, triggers_success, triggers_failed)
     SELECT u.id,
            $1::date,
            (SELECT COUNT(*)::int FROM events e WHERE e.user_id = u.id),
            COALESCE(t.total, 0),
            COALESCE(t.success, 0),
            COALESCE(t.failed, 0)
     FROM users u
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'success')::int AS success,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM event_trigger_logs
       WHERE user_id = u.id AND LEFT(trigger_date, 10) = $1::text
     ) t ON TRUE
     ON CONFLICT (user_id, stat_date) DO UPDATE SET
       events_count = EXCLUDED.events_count,
       triggers_total = EXCLUDED.triggers_total,
       triggers_success = EXCLUDED.triggers_success,
       triggers_failed = EXCLUDED.triggers_failed`,
    [statDate],
  );
  return result.rowCount ?? 0;
}
