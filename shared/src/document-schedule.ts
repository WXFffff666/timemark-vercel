/**
 * 证件保险箱（D2，todo 55）到期提醒工具 —— 纯函数，提醒引擎与测试共用。
 *
 * 与 expiry/inventory/maintenance 走同一个提醒引擎（backend/src/jobs/tasks.ts 的
 * runDatedReminderIterator），共享 reminder_send_claims 去重表，因此 send key
 * 带 `document:` 前缀隔离键空间。
 *
 * 提前天数按证件种类区分（todo 55 的明确要求）：
 * - passport / visa：[180, 90, 30, 7, 0]（航司与签证规则，长提前量确有价值）
 * - 其它种类：       [90, 30, 7, 0]
 * 用户的 documents.reminder_config.daysBeforeList 始终优先于默认值。
 */

/** 使用长提前量（含 180 天）的证件种类 */
export const DOCUMENT_LONG_LEAD_KINDS: readonly string[] = ['passport', 'visa'];

/** 默认提前提醒天数（passport/visa 以外） */
export const DEFAULT_DOCUMENT_LEAD_DAYS: readonly number[] = [90, 30, 7, 0];

/** passport / visa 的长提前量 */
export const LONG_LEAD_DOCUMENT_LEAD_DAYS: readonly number[] = [180, 90, 30, 7, 0];

/** 证件提醒去重键前缀（与事件/到期项/库存/保养键空间隔离） */
export const DOCUMENT_SEND_KEY_PREFIX = 'document';

/** 已过期最终提醒的事件类型（模板家族 document_expired） */
export const DOCUMENT_EXPIRED_EVENT_TYPE = 'document_expired';

/** 按证件 kind 返回默认提前天数表（未知 kind 走短表） */
export function documentLeadDays(kind: string): readonly number[] {
  return DOCUMENT_LONG_LEAD_KINDS.includes(kind)
    ? LONG_LEAD_DOCUMENT_LEAD_DAYS
    : DEFAULT_DOCUMENT_LEAD_DAYS;
}

/** 证件到期提醒去重键：`document:<today>#d<days>#t<HH:mm>` */
export function buildDocumentSendKey(todayYmd: string, daysUntil: number, reminderTime: string): string {
  return `${DOCUMENT_SEND_KEY_PREFIX}:${todayYmd}#d${daysUntil}#t${reminderTime}`;
}

/**
 * 已过期最终提醒的去重键：`document:expired#<expires_at>`。
 *
 * 键里**不含今天日期**，因此每本证件在其到期日之后只会收到一条「已过期」提醒；
 * 用户修改 expires_at 后键随之变化，会为新到期日重新提醒一次。
 */
export function buildDocumentExpiredKey(expiresAtYmd: string): string {
  return `${DOCUMENT_SEND_KEY_PREFIX}:expired#${expiresAtYmd}`;
}

/** 证件 kind（+ 是否已过期）→ 提醒模板事件类型（shared/src/templates.ts） */
export function documentEventType(kind: string, daysUntil: number): string {
  return daysUntil < 0 ? DOCUMENT_EXPIRED_EVENT_TYPE : `document_${kind}`;
}
