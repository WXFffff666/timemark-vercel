/**
 * 到期项（到期中心 D1）日期与费用工具 —— 纯函数，提醒引擎与前端共用。
 *
 * 与 events 的 reminder_send_claims 共享同一张表，因此 send key 带 `expiry:`
 * 前缀隔离键空间（事件键形如 `2026-01-20#d7#t09:00`）。
 */
import { formatYmd, parseYmd, toYmdString } from './event-schedule.js';

/** 默认提前提醒天数（可被 expiry_items.reminder_config.daysBeforeList 覆盖） */
export const DEFAULT_EXPIRY_LEAD_DAYS: readonly number[] = [30, 7, 3, 1, 0];

/** 默认提醒时刻（用户时区），与事件的 09:00 约定一致 */
export const DEFAULT_EXPIRY_REMINDER_TIMES: readonly string[] = ['09:00'];

/** 到期提醒去重键前缀（与事件键空间隔离） */
export const EXPIRY_SEND_KEY_PREFIX = 'expiry';

function daysInMonth(year: number, month: number): number {
  // month 为 1-12；Day 0 即上个月最后一天
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 按月推进并把「日」夹到目标月最后一天，绝不产生 2026-02-31 */
function addMonthsClamped(ymd: string, months: number): string | null {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  const total = parts.y * 12 + (parts.m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(parts.d, daysInMonth(year, month));
  return formatYmd(year, month, day);
}

function addDays(ymd: string, days: number): string | null {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  const time = Date.UTC(parts.y, parts.m - 1, parts.d) + Math.trunc(days) * 86400000;
  const date = new Date(time);
  return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * 计算续期后的 next_due_date（YYYY-MM-DD）。
 * - monthly / quarterly / yearly：按月推进并夹到目标月最后一天
 *   （2026-01-31 + 1月 → 2026-02-28；2024-02-29 + 1年 → 2025-02-28）
 * - custom：按 cycle_days 天推进（cycle_days 缺失/非正 → null）
 * - once：null（一次性到期项不可续期，路由返回 400）
 * - 无法解析的日期 → null
 */
export function advanceExpiryDate(
  dateYmd: string,
  cycle: string,
  cycleDays?: number | null,
): string | null {
  const ymd = toYmdString(dateYmd);
  if (!ymd) return null;
  switch (cycle) {
    case 'monthly':
      return addMonthsClamped(ymd, 1);
    case 'quarterly':
      return addMonthsClamped(ymd, 3);
    case 'yearly':
      return addMonthsClamped(ymd, 12);
    case 'custom':
      return typeof cycleDays === 'number' && cycleDays > 0 ? addDays(ymd, cycleDays) : null;
    case 'once':
    default:
      return null;
  }
}

/**
 * 把一笔金额折算为「每月成本」（整数分）。
 * monthly = 金额；quarterly = 金额/3；yearly = 金额/12；custom = 金额*30/cycle_days。
 * once 返回 null（不计入周期性总额，费用聚合单独列出）。
 */
export function normalizeMonthlyCostCents(
  amountCents: number | null | undefined,
  cycle: string,
  cycleDays?: number | null,
): number | null {
  if (amountCents == null || !Number.isFinite(amountCents)) return null;
  const amount = Math.round(amountCents);
  switch (cycle) {
    case 'monthly':
      return amount;
    case 'quarterly':
      return Math.round(amount / 3);
    case 'yearly':
      return Math.round(amount / 12);
    case 'custom':
      return typeof cycleDays === 'number' && cycleDays > 0 ? Math.round((amount * 30) / cycleDays) : null;
    case 'once':
    default:
      return null;
  }
}

/** 到期提醒去重键：`expiry:<today>#d<days>#t<HH:mm>` */
export function buildExpirySendKey(todayYmd: string, daysUntil: number, reminderTime: string): string {
  return `${EXPIRY_SEND_KEY_PREFIX}:${todayYmd}#d${daysUntil}#t${reminderTime}`;
}

/** 到期项 kind → 提醒模板事件类型（shared/src/templates.ts 的 expiry_* 家族） */
export function expiryEventType(kind: string): string {
  return `expiry_${kind}`;
}
