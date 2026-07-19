/**
 * 事件下次发生日期（公历）—— 与前端倒计时、Cron 提醒共用
 */

export function parseYmd(dateStr: string): { y: number; m: number; d: number } | null {
  const ymd = dateStr.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function formatYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** UTC 日历日差：dateB - dateA（YYYY-MM-DD） */
export function diffCalendarDays(dateA: string, dateB: string): number {
  const a = new Date(dateA.slice(0, 10) + 'T00:00:00Z');
  const b = new Date(dateB.slice(0, 10) + 'T00:00:00Z');
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function isYearlyOccurrenceEvent(
  eventType?: string,
  recurringConfig?: { enabled?: boolean; frequency?: string } | null,
): boolean {
  if (eventType === 'birthday' || eventType === 'anniversary') return true;
  return !!(recurringConfig?.enabled && recurringConfig.frequency === 'yearly');
}

/**
 * 将存储日期滚动到「不早于 today」的下次公历发生日。
 * 生日存 1990-07-28 时，在 2026 年应解析为 2026-07-28。
 */
export function resolveNextGregorianOccurrence(
  eventDate: string,
  todayYmd: string,
  options?: {
    eventType?: string;
    recurringConfig?: { enabled?: boolean; frequency?: string } | null;
    nextOccurrence?: string | null;
  },
): string {
  if (options?.nextOccurrence) {
    const occ = options.nextOccurrence.slice(0, 10);
    if (diffCalendarDays(todayYmd, occ) >= 0) return occ;
  }

  const parts = parseYmd(eventDate);
  if (!parts) return eventDate.slice(0, 10);

  const yearly = isYearlyOccurrenceEvent(options?.eventType, options?.recurringConfig);
  if (!yearly) {
    return formatYmd(parts.y, parts.m, parts.d);
  }

  const todayParts = parseYmd(todayYmd);
  let year = todayParts?.y ?? parts.y;
  let candidate = formatYmd(year, parts.m, parts.d);

  if (diffCalendarDays(todayYmd, candidate) < 0) {
    candidate = formatYmd(year + 1, parts.m, parts.d);
  }

  return candidate;
}

/** 构建单次提醒发送的去重键（同一天、同一提前档位、同一时刻） */
export function buildReminderSendKey(todayYmd: string, daysUntil: number, reminderTime: string): string {
  return `${todayYmd}#d${daysUntil}#t${reminderTime}`;
}
