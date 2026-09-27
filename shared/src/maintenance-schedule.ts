/**
 * 保养计划（D12）重算与用量阈值工具 —— 纯函数，服务层与提醒引擎共用。
 */
import { formatYmd, parseYmd, toYmdString } from './event-schedule.js';

/** 默认提前提醒天数（可被 maintenance_plans.reminder_config.daysBeforeList 覆盖） */
export const DEFAULT_MAINTENANCE_LEAD_DAYS: readonly number[] = [30, 7, 3, 1, 0];

/** 默认提醒时刻（用户时区），与事件/到期项的 09:00 约定一致 */
export const DEFAULT_MAINTENANCE_REMINDER_TIMES: readonly string[] = ['09:00'];

/** 保养提醒去重键前缀（与事件/到期项/库存键空间隔离） */
export const MAINTENANCE_SEND_KEY_PREFIX = 'maintenance';

/** 用量提醒触发比例：剩余量 <= 间隔的 10% 时提醒 */
export const USAGE_NUDGE_RATIO = 0.1;

/** 日期推进（YYYY-MM-DD + 天数），解析失败返回 null */
export function addDaysYmd(ymd: string, days: number): string | null {
  const text = toYmdString(ymd);
  if (!text || !Number.isFinite(days)) return null;
  const parts = parseYmd(text);
  if (!parts) return null;
  const time = Date.UTC(parts.y, parts.m - 1, parts.d) + Math.trunc(days) * 86400000;
  const date = new Date(time);
  return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** next_due_at = done_at + interval_days；interval_days 缺失/非法 → null */
export function computeNextDueAt(doneAtYmd: string, intervalDays: number | null | undefined): string | null {
  if (intervalDays == null || !Number.isFinite(intervalDays) || intervalDays <= 0) return null;
  return addDaysYmd(doneAtYmd, intervalDays);
}

/** next_due_usage = usage_at + interval_usage；interval_usage 缺失/非法 → null */
export function computeNextDueUsage(
  usageAt: number | null | undefined,
  intervalUsage: number | null | undefined,
): number | null {
  if (usageAt == null || !Number.isFinite(usageAt)) return null;
  if (intervalUsage == null || !Number.isFinite(intervalUsage) || intervalUsage <= 0) return null;
  return usageAt + intervalUsage;
}

/**
 * 用量是否进入提醒阈值：剩余量（next_due_usage - current_usage）<= interval_usage * ratio。
 * - 任一值缺失 → false（不做用量提醒）
 * - 已到期/超期（剩余 <= 0）同样为 true —— 这是最需要提醒的情形
 */
export function usageNeedsNudge(params: {
  currentUsage: number | null | undefined;
  nextDueUsage: number | null | undefined;
  intervalUsage: number | null | undefined;
  ratio?: number;
}): boolean {
  const { currentUsage, nextDueUsage, intervalUsage } = params;
  const ratio = params.ratio ?? USAGE_NUDGE_RATIO;
  if (currentUsage == null || nextDueUsage == null || intervalUsage == null) return false;
  if (!Number.isFinite(currentUsage) || !Number.isFinite(nextDueUsage) || !Number.isFinite(intervalUsage)) {
    return false;
  }
  if (intervalUsage <= 0 || ratio <= 0) return false;
  return nextDueUsage - currentUsage <= intervalUsage * ratio;
}

/** 保养日期提醒去重键：`maintenance:<today>#d<days>#t<HH:mm>` */
export function buildMaintenanceSendKey(todayYmd: string, daysUntil: number, reminderTime: string): string {
  return `${MAINTENANCE_SEND_KEY_PREFIX}:${todayYmd}#d${daysUntil}#t${reminderTime}`;
}

/**
 * 用量提醒去重键：`maintenance:usage#<planId>#u<nextDueUsage>`。
 * 下一次保养用量变化后键随之变化，因此每个保养周期最多提醒一次。
 */
export function buildMaintenanceUsageKey(planId: number, nextDueUsage: number): string {
  return `${MAINTENANCE_SEND_KEY_PREFIX}:usage#${planId}#u${nextDueUsage}`;
}

/** 资产类型 → 提醒模板事件类型（shared/src/templates.ts 的 maintenance_* 家族） */
export function maintenanceEventType(assetKind: string): string {
  return `maintenance_${assetKind}`;
}
