/** Task 136: the configurable "Today at-a-glance" card registry. */

export const TODAY_CARD_IDS = [
  'events',
  'reminders',
  'doses',
  'habits',
  'expiring',
  'todos',
  'ai',
] as const;

export type TodayCardId = (typeof TODAY_CARD_IDS)[number];

/** Default render order (also the order new users see). */
export const DEFAULT_TODAY_CARD_ORDER: TodayCardId[] = [...TODAY_CARD_IDS];

export interface TodayCardMeta {
  id: TodayCardId;
  title: string;
  description: string;
  /** Where the card's "view all" action navigates. */
  href: string;
}

export const TODAY_CARD_META: Record<TodayCardId, TodayCardMeta> = {
  events: { id: 'events', title: '今日事件', description: '今天发生的事件', href: '/calendar' },
  reminders: { id: 'reminders', title: '提醒记录', description: '最近的提醒发送记录', href: '/trigger-logs' },
  doses: { id: 'doses', title: '今日用药', description: '今天需要服用的剂量', href: '/medications' },
  habits: { id: 'habits', title: '今日习惯', description: '今天待打卡的习惯', href: '/habits' },
  expiring: { id: 'expiring', title: '即将到期', description: '30 天内到期的订阅 / 账单等', href: '/expiry' },
  todos: { id: 'todos', title: '逾期待办', description: '已过期待完成的事件待办', href: '/todos' },
  ai: { id: 'ai', title: 'AI / 队列状态', description: 'AI 供应商与任务队列的简要状态', href: '/agent-console' },
};

export function isTodayCardId(value: unknown): value is TodayCardId {
  return typeof value === 'string' && (TODAY_CARD_IDS as readonly string[]).includes(value);
}
