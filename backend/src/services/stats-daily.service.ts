import { query } from '../db/index.js';

/**
 * 10-char prefix invariant (migration 51): `event_trigger_logs.trigger_date` is TEXT.
 * A row's first 10 chars are a calendar day `YYYY-MM-DD` ONLY for legacy rows (exactly
 * 10 chars) and for normal dedup tokens `YYYY-MM-DD#d<n>#tHH:mm`. Namespaced keys such as
 * `snooze:event#<id>#<ISO>` (buildSnoozeSendKey -> recordEventTrigger at
 * `backend/src/jobs/tasks.ts`) carry NO leading date - `LEFT('snooze:event#...', 10)` is
 * `snooze:eve` - so they must be EXCLUDED by a truthful prefix comparison, never
 * truncated, never cast (`text = date` -> 42883; `::date` -> 22007 on any token row).
 * The equality below can only ever match a real `YYYY-MM-DD` prefix, so namespaced rows
 * are excluded by construction.
 *
 * The day is computed in SQL for BOTH the INSERT target and the comparison so an
 * off-schedule/manual run can never split one aggregation across two days when the host
 * clock and the DB clock disagree. A host-local `yesterdayYmd()` is not safe here: on a
 * UTC host it yields `CURRENT_DATE - 1` only after 00:00 UTC, so between 16:00-24:00 UTC
 * it aggregated the wrong day for a +08 user (`stat_date` vs the `trigger_date` prefix).
 * `(CURRENT_DATE - INTERVAL '1 day')::date` keeps `stat_date` a real DATE and
 * `::date::text` keeps the prefix comparison on the same DB-local day.
 */
export async function aggregateDailyStats(): Promise<number> {
  const result = await query(
    `INSERT INTO stats_daily (user_id, stat_date, events_count, triggers_total, triggers_success, triggers_failed)
     SELECT u.id,
            (CURRENT_DATE - INTERVAL '1 day')::date,
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
       WHERE user_id = u.id AND LEFT(trigger_date, 10) = (CURRENT_DATE - INTERVAL '1 day')::date::text
     ) t ON TRUE
     ON CONFLICT (user_id, stat_date) DO UPDATE SET
       events_count = EXCLUDED.events_count,
       triggers_total = EXCLUDED.triggers_total,
       triggers_success = EXCLUDED.triggers_success,
       triggers_failed = EXCLUDED.triggers_failed`,
  );
  return result.rowCount ?? 0;
}
