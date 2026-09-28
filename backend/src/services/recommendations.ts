import { query } from '../db/index.js';

/** Smart recommended reminder days by event type (no AI / no API key). */
const RECOMMENDATIONS: Record<string, number[]> = {
  birthday: [0, 1, 3, 7],
  anniversary: [0, 1, 7, 14],
  exam: [0, 1, 3, 7, 14],
  holiday: [0, 1, 3],
  meeting: [0, 1],
  deadline: [0, 1, 3, 7],
  travel: [0, 1, 3],
  graduation: [0, 1, 7],
  wedding: [0, 1, 7, 14],
  medical: [0, 1],
  custom: [0, 1, 3],
};

/**
 * 10-char prefix invariant (migration 51): `event_trigger_logs.trigger_date` is TEXT.
 * A row's first 10 chars are a calendar day `YYYY-MM-DD` ONLY for legacy rows (exactly
 * 10 chars) and for normal dedup tokens `YYYY-MM-DD#d<n>#tHH:mm`. Namespaced keys such as
 * `snooze:event#<id>#<ISO>` (buildSnoozeSendKey -> recordEventTrigger) carry NO leading
 * date, so they must be EXCLUDED by a guard, never truncated: `LEFT('snooze:event#...', 10)`
 * is `snooze:eve`, and `new Date('...#d0#t09:00')` is an Invalid Date. `ymdPrefix` below is
 * that guard - its regex returns null for any key that does not start with a real ymd, so
 * namespaced rows contribute no history day. DATE values from `pg` (legacy rows only) are
 * normalised with LOCAL getters, the exact inverse of how postgres-date builds them.
 */
function ymdPrefix(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const s = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** UTC midnight of a YYYY-MM-DD - a DST-free calendar day, so day diffs stay exact. */
function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function getRecommendedDaysBefore(eventType: string): number[] {
  return RECOMMENDATIONS[eventType] ?? [0, 1, 3, 7];
}

/** C8: 基于历史触发统计推荐 daysBefore */
export async function getRecommendedDaysFromHistory(userId: number, eventType: string): Promise<number[]> {
  const result = await query(
    `SELECT e.reminder_config, e.date, tl.trigger_date, tl.status
     FROM event_trigger_logs tl
     JOIN events e ON e.id = tl.event_id
     WHERE tl.user_id = $1 AND e.type = $2 AND tl.status = 'success'
     ORDER BY tl.created_at DESC LIMIT 50`,
    [userId, eventType],
  );
  const dayCounts = new Map<number, number>();
  for (const row of result.rows as Array<{ reminder_config: string; date: string | Date; trigger_date: string | Date }>) {
    try {
      const cfg = typeof row.reminder_config === 'string' ? JSON.parse(row.reminder_config) : row.reminder_config;
      const eventYmd = ymdPrefix(row.date);
      const triggerYmd = ymdPrefix(row.trigger_date);
      if (eventYmd && triggerYmd) {
        const diff = Math.round((ymdToUtcMs(eventYmd) - ymdToUtcMs(triggerYmd)) / 86400000);
        if (diff >= 0 && diff <= 30) {
          dayCounts.set(diff, (dayCounts.get(diff) || 0) + 1);
        }
      }
      if (Array.isArray(cfg?.daysBeforeList)) {
        for (const d of cfg.daysBeforeList) {
          if (typeof d === 'number') dayCounts.set(d, (dayCounts.get(d) || 0) + 1);
        }
      }
    } catch { /* ignore */ }
  }
  if (dayCounts.size === 0) return [];
  return [...dayCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([d]) => d)
    .sort((a, b) => b - a);
}
