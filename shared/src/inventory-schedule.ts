/**
 * 库存（D12）提醒 schedule 工具 —— 纯函数。
 *
 * 与到期中心共享同一张 reminder_send_claims，因此 send key 带 `inventory:`
 * 前缀隔离键空间（事件键形如 `2026-01-20#d7#t09:00`，到期项键形如
 * `expiry:2026-01-20#d7#t09:00`）。
 */

/** 默认提前提醒天数（可被 inventory_items.reminder_config.daysBeforeList 覆盖） */
export const DEFAULT_INVENTORY_LEAD_DAYS: readonly number[] = [30, 7, 3, 1, 0];

/** 默认提醒时刻（用户时区），与事件/到期项的 09:00 约定一致 */
export const DEFAULT_INVENTORY_REMINDER_TIMES: readonly string[] = ['09:00'];

/** 库存提醒去重键前缀（与事件/到期项键空间隔离） */
export const INVENTORY_SEND_KEY_PREFIX = 'inventory';

/** 库存提醒去重键：`inventory:<today>#d<days>#t<HH:mm>` */
export function buildInventorySendKey(todayYmd: string, daysUntil: number, reminderTime: string): string {
  return `${INVENTORY_SEND_KEY_PREFIX}:${todayYmd}#d${daysUntil}#t${reminderTime}`;
}

/** 库存项 category → 提醒模板事件类型（shared/src/templates.ts 的 inventory_* 家族） */
export function inventoryEventType(category: string): string {
  return `inventory_${category}`;
}
