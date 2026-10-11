import type { Event, LunarDate } from '@timemark/shared';
import { Lunar } from 'lunar-javascript';
import {
  diffCalendarDays,
  pickSoonestOccurrenceOnOrAfter,
  resolveNextGregorianOccurrence,
} from '@timemark/shared/event-schedule';
import { DEFAULT_TIMEZONE, getTodayDateKey, zonedYmdTimeToDate } from './timezone-utils';

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function dateKey(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** @deprecated Prefer getTodayDateKey(timeZone) for user-configured timezone */
export function startOfLocalDay(ref: Date = new Date()): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function parseEventDate(dateStr: string): Date {
  const ymd = dateStr.slice(0, 10);
  return new Date(`${ymd}T00:00:00`);
}

/** 距事件还有多少天（0 = 今天，负数 = 已过期），基于用户时区日历日 */
export function daysUntilEvent(
  dateStr: string,
  ref = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
): number {
  const today = getTodayDateKey(timeZone, ref);
  const target = dateStr.slice(0, 10);
  return diffCalendarDays(today, target);
}

/** 将农历月日滚动到不早于 today 的下次公历发生日 */
function resolveNextLunarOccurrence(
  lunarDate: LunarDate,
  todayYmd: string,
  refYear = new Date().getFullYear(),
): string | null {
  const month = lunarDate.isLeap ? -lunarDate.month : lunarDate.month;
  const candidates: string[] = [];
  for (const year of [refYear, refYear + 1]) {
    try {
      const solar = Lunar.fromYmd(year, month, lunarDate.day).getSolar();
      candidates.push(
        `${solar.getYear()}-${String(solar.getMonth()).padStart(2, '0')}-${String(solar.getDay()).padStart(2, '0')}`,
      );
    } catch {
      // invalid lunar date for this year
    }
  }
  return pickSoonestOccurrenceOnOrAfter(todayYmd, candidates);
}

/** 生日/纪念日等默认按年滚动；农历/双历取最近候选日 */
export function resolveNextOccurrenceDate(
  event: Event,
  ref = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const today = getTodayDateKey(timeZone, ref);
  const gregorian = resolveNextGregorianOccurrence(event.date, today, {
    eventType: event.type,
    recurringConfig: event.recurringConfig ?? null,
    nextOccurrence: event.nextOccurrence ?? null,
  });

  if (event.calendarType === 'gregorian' || !event.lunarDate) {
    return gregorian;
  }

  const refYear = Number.parseInt(today.slice(0, 4), 10);
  const lunarNext = resolveNextLunarOccurrence(event.lunarDate, today, refYear);

  if (event.calendarType === 'lunar') {
    return lunarNext ?? gregorian;
  }

  if (lunarNext) {
    return pickSoonestOccurrenceOnOrAfter(today, [gregorian, lunarNext]) ?? gregorian;
  }

  return gregorian;
}

/**
 * 倒计时目标时刻：下次事件日期 + 当天首个提醒时间（默认 00:00，按用户时区）
 */
export function getEventCountdownTarget(
  event: Event,
  ref = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
): Date | null {
  const dateStr = resolveNextOccurrenceDate(event, ref, timeZone);
  const time = event.reminderConfig?.reminderTimes?.[0];
  if (time && /^\d{1,2}:\d{2}$/.test(time)) {
    const [h, m] = time.split(':').map(Number);
    return zonedYmdTimeToDate(dateStr, h, m, timeZone);
  }
  return zonedYmdTimeToDate(dateStr, 0, 0, timeZone);
}

export function diffToCountdownParts(target: Date, ref = new Date()): CountdownParts | null {
  const diff = target.getTime() - ref.getTime();
  if (diff <= 0) return null;
  return {
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff % 86400000) / 3600000),
    minutes: Math.floor((diff % 3600000) / 60000),
    seconds: Math.floor((diff % 60000) / 1000),
  };
}

export function isEventCountdownPast(
  event: Event,
  ref = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
): boolean {
  const target = getEventCountdownTarget(event, ref, timeZone);
  if (!target) return true;
  return target.getTime() <= ref.getTime();
}

/**
 * 事件是否进入「待办」窗口：
 * 当距离事件日期 ≤ 提醒配置里最大的「提前 N 天」时显示（默认 7 天内）
 */
export function isEventInTodoWindow(
  event: Event,
  ref = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
): boolean {
  if (event.reminderConfig?.enabled === false) return false;
  const days = daysUntilEvent(resolveNextOccurrenceDate(event, ref, timeZone), ref, timeZone);
  const list = event.reminderConfig?.daysBeforeList?.length
    ? event.reminderConfig.daysBeforeList
    : [7];
  const maxBefore = Math.max(...list, 0);
  return days >= 0 && days <= maxBefore;
}

export function todoCompletionKey(eventId: string | number, date: string): string {
  return `${eventId}:${date.slice(0, 10)}`;
}

export function buildCompletedSet(
  completions: Array<{ eventId: number; occurrenceDate: string }>,
): Set<string> {
  return new Set(completions.map((c) => todoCompletionKey(c.eventId, c.occurrenceDate)));
}

export function getTodoEvents(
  events: Event[],
  ref = new Date(),
  completedKeys?: Set<string>,
  timeZone: string = DEFAULT_TIMEZONE,
): Event[] {
  return events
    .filter((e) => isEventInTodoWindow(e, ref, timeZone))
    .filter((e) => !completedKeys?.has(todoCompletionKey(e.id, e.date)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function groupEventsByDate(events: Event[]): Map<string, Event[]> {
  const map = new Map<string, Event[]>();
  for (const e of events) {
    const key = e.date.slice(0, 10);
    const list = map.get(key) || [];
    list.push(e);
    map.set(key, list);
  }
  return map;
}

/**
 * v2.31 R4（审计 D2）：事件在指定年份的「落位日期集」。
 *
 * 旧日历网格/列表直接按原始 `date` 落位——重复（yearly/monthly）与农历/双历事件
 * 在其发生年份的网格上永远查不到（生日 1990-07-28 在 2026 年 7 月不存在），而
 * EventCard/Dashboard 用 resolveNextOccurrenceDate，两处口径互相矛盾。
 *
 * 规则：
 * - yearly（显式配置）公历面：月-日滚动到目标年（02-29 在平年跳过，不虚构 03-01）
 * - monthly：日滚动到目标年每个月（clamp 到月末）
 * - 农历/双历且有 lunarDate：农历转换到目标年
 * - 其余（一次性事件）：原始日期，任何年份都按原样展示（历史保留）
 * - 农历/双历一次性事件：原始公历 date 与农历转换日都落位（双历语义）
 */
export function getEventOccurrenceDatesInYear(event: Event, year: number): string[] {
  const raw = event.date.slice(0, 10);
  const mm = Number.parseInt(raw.slice(5, 7), 10);
  const dd = Number.parseInt(raw.slice(8, 10), 10);
  if (!Number.isFinite(mm) || !Number.isFinite(dd)) return [raw];

  const recurring = event.recurringConfig ?? null;
  const frequency = recurring?.enabled ? recurring.frequency : null;
  const out: string[] = [];
  const push = (key: string) => {
    if (!out.includes(key)) out.push(key);
  };
  const validGregorian = (y: number, m: number, d: number): string | null => {
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  };

  // 公历面
  if (event.calendarType === 'gregorian' || event.calendarType === 'both' || !event.lunarDate) {
    if (frequency === 'yearly') {
      // 02-29 在平年跳过（不虚构 03-01）；该年无落位就是无，不回退原始日期
      const rolled = validGregorian(year, mm, dd);
      if (rolled) push(rolled);
    } else if (frequency === 'monthly') {
      for (let m = 1; m <= 12; m += 1) {
        const rolled = validGregorian(year, m, Math.min(dd, new Date(Date.UTC(year, m, 0)).getUTCDate()));
        if (rolled) push(rolled);
      }
    } else if (frequency === 'weekly' || frequency === 'daily') {
      // v2.37 R25：weekly/daily 展开——从原始日期锚点起，每隔 interval 周天的落位。
      // 日历粒度小（单用户几百事件），逐日判定足够快。
      const interval = Math.max(1, recurring?.interval ?? 1);
      const stepDays = frequency === 'weekly' ? 7 * interval : interval;
      const anchor = Date.UTC(Number(raw.slice(0, 4)), mm - 1, dd);
      const jan1 = Date.UTC(year, 0, 1);
      const dec31 = Date.UTC(year, 11, 31);
      // 对齐到锚点步进：第一个 ≥1/1 的落位日
      const offsetDays = Math.ceil((jan1 - anchor) / 86_400_000);
      const firstOffset = Math.max(0, Math.ceil(offsetDays / stepDays) * stepDays);
      for (let offset = firstOffset; anchor + offset * 86_400_000 <= dec31; offset += stepDays) {
        const d = new Date(anchor + offset * 86_400_000);
        push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
      }
    } else {
      push(raw);
    }
  }

  // 农历面（lunar / both 且有农历数据）
  if ((event.calendarType === 'lunar' || event.calendarType === 'both') && event.lunarDate) {
    const month = event.lunarDate.isLeap ? -event.lunarDate.month : event.lunarDate.month;
    try {
      const solar = Lunar.fromYmd(year, month, event.lunarDate.day).getSolar();
      // 注意：lunar-javascript 的 Solar API 是 getYear()（没有 getFullYear，那是浏览器 Date 的）
      push(
        `${solar.getYear()}-${String(solar.getMonth()).padStart(2, '0')}-${String(solar.getDay()).padStart(2, '0')}`,
      );
    } catch (err) {
      // 该年无此农历日（如闰月缺失）——静默跳过
    }
  }

  // 仅一次性事件在转换全失败时回退原始日期；重复事件该年无落位就是无
  return out.length > 0 || frequency ? out : [raw];
}

/** 日历网格/年视图/列表的统一落位：按目标年展开全部事件的 occurrence 集合。 */
export function groupEventsByOccurrence(events: Event[], year: number): Map<string, Event[]> {
  const map = new Map<string, Event[]>();
  for (const e of events) {
    for (const key of getEventOccurrenceDatesInYear(e, year)) {
      const list = map.get(key) || [];
      list.push(e);
      map.set(key, list);
    }
  }
  return map;
}

const TYPE_LABELS: Record<string, string> = {
  birthday: '生日',
  anniversary: '纪念日',
  exam: '考试',
  holiday: '节日',
  meeting: '会议',
  deadline: '截止',
  travel: '出行',
  graduation: '毕业',
  wedding: '婚礼',
  medical: '医疗',
  other: '其他',
};

export function eventTypeLabel(type: string) {
  return TYPE_LABELS[type] || type;
}

/** 事件是否落在用户时区的「今天」 */
export function isEventToday(
  event: Event,
  ref = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
): boolean {
  const today = getTodayDateKey(timeZone, ref);
  const next = resolveNextOccurrenceDate(event, ref, timeZone);
  return next === today;
}
