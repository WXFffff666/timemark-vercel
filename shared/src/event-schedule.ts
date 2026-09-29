/**
 * 事件下次发生日期（公历）—— 与前端倒计时、Cron 提醒共用
 */

/**
 * 将 DB/API 的日期值规范为 YYYY-MM-DD（兼容 pg DATE → Date 对象）。
 *
 * 不变式：pg 驱动把 DATE 列解析为「本地午夜」的 Date（postgres-date 内部是
 * `new Date(y, m, d)`），因此对 Date 输入必须用本地 getter 取回同一公历日 ——
 * 这是该构造的精确逆运算。getUTC* / toISOString 在东八区（生产 TZ=Asia/Shanghai）
 * 会把日期回退一天（DATE 2026-10-03 → "2026-10-02"）。
 * 字符串分支区分两种形态：纯 `YYYY-MM-DD` 直接切片；完整 ISO 瞬时按 LOCAL
 * getter 取回本地日（见下方注释）。这样无论缓存写读是否同一时区，日历日都不漂移。
 */
/** 用 LOCAL getter 取回 YYYY-MM-DD（pg DATE 为本地午夜；UTC getter / toISOString 会错位）。 */
function ymdFromLocalDate(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toYmdString(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return ymdFromLocalDate(value);
  }
  const s = String(value);
  // 纯日历日 `YYYY-MM-DD`（无时间）原样返回。若对其 parse 再取本地 getter，负偏移
  // 时区会把日期前移一天（`new Date('2026-09-29')` 是 UTC 午夜 → 纽约为 09-28）。
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 完整 ISO 瞬时（含时间）：解析为时间点后用 LOCAL getter 取本地日历日。这正是
  // `Date` → `toISOString()` 的逆运算：pg DATE 是本地午夜，缓存 JSON 瞬时能来回还原。
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const parsed = new Date(s);
    if (isNaN(parsed.getTime())) return null;
    return ymdFromLocalDate(parsed);
  }
  return null;
}

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
  eventDate: string | Date,
  todayYmd: string,
  options?: {
    eventType?: string;
    recurringConfig?: { enabled?: boolean; frequency?: string } | null;
    nextOccurrence?: string | Date | null;
  },
): string {
  const nextOcc = toYmdString(options?.nextOccurrence);
  if (nextOcc) {
    if (diffCalendarDays(todayYmd, nextOcc) >= 0) return nextOcc;
  }

  const normalizedEventDate = toYmdString(eventDate);
  const parts = normalizedEventDate ? parseYmd(normalizedEventDate) : null;
  if (!parts) return (normalizedEventDate ?? String(eventDate)).slice(0, 10);

  const yearly = isYearlyOccurrenceEvent(options?.eventType, options?.recurringConfig);
  if (!yearly) {
    return formatYmd(parts.y, parts.m, parts.d);
  }

  const todayParts = parseYmd(todayYmd);
  const year = todayParts?.y ?? parts.y;
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

/**
 * 补发窗口上限（分钟，checkbox 166）。给 catch-up 一个硬上界：无论调用方传入什么，
 * 迟到方向都不会超过 1 小时，因此分钟差算术不可能把窗口卷到「昨天的槽位」。
 */
export const REMINDER_CATCH_UP_MAX_MINUTES = 60;

/** 当前时刻相对提醒时刻的分钟差（迟到为正、提前为负）；任一时间无法解析时返回 null。 */
export function reminderOffsetMinutes(currentHHmm: string, targetHHmm: string): number | null {
  const [ch, cm] = currentHHmm.split(':').map(Number);
  const [th, tm] = targetHHmm.split(':').map(Number);
  if (![ch, cm, th, tm].every((n) => Number.isFinite(n))) return null;
  return ch * 60 + cm - (th * 60 + tm);
}

/**
 * Cron 每分钟执行：当前时刻是否在提醒窗口内。
 *
 * - 准时窗口对称且不缩水：|current - target| <= windowMinutes（默认 ±2 分钟，旧行为逐位等价）。
 * - catchUpMinutes > 0 时只向「迟到」方向扩展 —— [target, target + catchUpMinutes]，用于 cron
 *   漏跑数分钟后的有界补发；提前方向绝不扩展（提醒永不早于设定时刻）。
 * - 上限 REMINDER_CATCH_UP_MAX_MINUTES；catchUpMinutes = 0（默认）时与旧实现完全一致。
 */
export function matchesReminderTimeWindow(
  currentHHmm: string,
  targetHHmm: string,
  windowMinutes = 2,
  catchUpMinutes = 0,
): boolean {
  const diff = reminderOffsetMinutes(currentHHmm, targetHHmm);
  if (diff === null) return false;
  const boundedCatchUp = Math.min(Math.max(catchUpMinutes, 0), REMINDER_CATCH_UP_MAX_MINUTES);
  return diff >= -windowMinutes && diff <= Math.max(windowMinutes, boundedCatchUp);
}

/** 在多个候选公历日中取「不早于 today」且最近的一天 */
export function pickSoonestOccurrenceOnOrAfter(todayYmd: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const ymd = c.slice(0, 10);
    const diff = diffCalendarDays(todayYmd, ymd);
    if (diff >= 0 && diff < bestDiff) {
      best = ymd;
      bestDiff = diff;
    }
  }
  return best;
}
