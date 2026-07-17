import type { Event } from '@timemark/shared';

export function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function dateKey(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseEventDate(dateStr: string): Date {
  return new Date(dateStr.slice(0, 10) + 'T00:00:00');
}

/** 距事件还有多少天（0 = 今天，负数 = 已过期） */
export function daysUntilEvent(dateStr: string, ref = new Date()): number {
  const target = parseEventDate(dateStr);
  const today = new Date(ref);
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/**
 * 事件是否进入「待办」窗口：
 * 当距离事件日期 ≤ 提醒配置里最大的「提前 N 天」时显示（默认 7 天内）
 */
export function isEventInTodoWindow(event: Event, ref = new Date()): boolean {
  if (event.reminderConfig?.enabled === false) return false;
  const days = daysUntilEvent(event.date, ref);
  const list = event.reminderConfig?.daysBeforeList?.length
    ? event.reminderConfig.daysBeforeList
    : [7];
  const maxBefore = Math.max(...list, 0);
  return days >= 0 && days <= maxBefore;
}

export function getTodoEvents(events: Event[], ref = new Date()): Event[] {
  return events
    .filter((e) => isEventInTodoWindow(e, ref))
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
