/**
 * 联系节奏（D4，checkbox 62）提醒工具 —— 纯函数，提醒任务与测试共用。
 *
 * 一个「节奏周期」= 最后一次有效联系日（用户时区的日历日）到 + cadence_days。
 * 周期起点每天只可能有一个值，所以提醒去重键 = 联系人 id + 周期起点：
 * - 同一周期内 cron 每分钟跑：claim 冲突 → 至多一条提醒（绝不每日唠叨）；
 * - 用户今天记录了一次互动：周期起点前移 → 新键 → 下个周期可以再提醒一次。
 *
 * 「从未联系」（有效最后联系时间为 NULL）没有周期起点 → 跳过，不发
 * 「上次联系：从未」的骚扰；联系人页的到期列表仍会展示它（由路由决定）。
 */
import { diffCalendarDays, formatYmd, parseYmd } from './event-schedule.js';

export const CONTACT_CADENCE_SEND_KEY_PREFIX = 'contact:cadence';

/** 周期起点 + N 个日历日（YYYY-MM-DD）；非法输入返回 null */
export function cadenceNextDueYmd(periodStartYmd: string, cadenceDays: number): string | null {
  const parts = parseYmd(periodStartYmd);
  if (!parts) return null;
  if (!Number.isInteger(cadenceDays) || cadenceDays <= 0) return null;
  const t = Date.UTC(parts.y, parts.m - 1, parts.d) + cadenceDays * 86400000;
  const d = new Date(t);
  return formatYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 今天是否已到（或已过）该节奏的下次到期日；非法输入一律 false（不提醒） */
export function isCadenceDue(todayYmd: string, periodStartYmd: string, cadenceDays: number): boolean {
  const due = cadenceNextDueYmd(periodStartYmd, cadenceDays);
  if (!due || !parseYmd(todayYmd)) return false;
  // diffCalendarDays(A, B) = B - A；due - today <= 0 即已到期
  return diffCalendarDays(todayYmd, due) <= 0;
}

/** 去重键：`contact:cadence#c<联系人id>#p<周期起点>`（周期起点是键的一部分，改动即换新周期） */
export function buildCadenceSendKey(contactId: number, periodStartYmd: string): string {
  return `${CONTACT_CADENCE_SEND_KEY_PREFIX}#c${contactId}#p${periodStartYmd}`;
}
