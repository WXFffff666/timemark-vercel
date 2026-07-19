import type { Event } from '@timemark/shared';
import {
  diffCalendarDays,
  resolveNextGregorianOccurrence,
} from '@timemark/shared/event-schedule';

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

export function startOfLocalDay(ref: Date = new Date()): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function parseEventDate(dateStr: string): Date {
  const ymd = dateStr.slice(0, 10);
  return new Date(`${ymd}T00:00:00`);
}

/** 距事件还有多少天（0 = 今天，负数 = 已过期） */
export function daysUntilEvent(dateStr: string, ref = new Date()): number {
  const target = startOfLocalDay(parseEventDate(dateStr));
  const today = startOfLocalDay(ref);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** 生日/纪念日等默认按年滚动；优先使用服务端 nextOccurrence */
export function resolveNextOccurrenceDate(event: Event, ref = new Date()): string {
  const today = dateKey(startOfLocalDay(ref));
  return resolveNextGregorianOccurrence(event.date, today, {
    eventType: event.type,
    recurringConfig: event.recurringConfig ?? null,
    nextOccurrence: event.nextOccurrence ?? null,
  });
}

/**
 * 倒计时目标时刻：下次事件日期 + 当天首个提醒时间（默认 00:00）
 * 注意：不按「提前 N 天的提醒推送时刻」倒计时，避免只剩十几小时。
 */
export function getEventCountdownTarget(event: Event, ref = new Date()): Date | null {
  const dateStr = resolveNextOccurrenceDate(event, ref);
  const target = parseEventDate(dateStr);
  const time = event.reminderConfig?.reminderTimes?.[0];
  if (time && /^\d{1,2}:\d{2}$/.test(time)) {
    const [h, m] = time.split(':').map(Number);
    target.setHours(h, m, 0, 0);
  }
  return target;
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

export function isEventCountdownPast(event: Event, ref = new Date()): boolean {
  const target = getEventCountdownTarget(event, ref);
  if (!target) return true;
  return target.getTime() <= ref.getTime();
}

/**
 * 事件是否进入「待办」窗口：
 * 当距离事件日期 ≤ 提醒配置里最大的「提前 N 天」时显示（默认 7 天内）
 */
export function isEventInTodoWindow(event: Event, ref = new Date()): boolean {
  if (event.reminderConfig?.enabled === false) return false;
  const days = daysUntilEvent(resolveNextOccurrenceDate(event, ref), ref);
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
): Event[] {
  return events
    .filter((e) => isEventInTodoWindow(e, ref))
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
