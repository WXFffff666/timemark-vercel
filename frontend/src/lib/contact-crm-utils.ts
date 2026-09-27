import type {
  GiftDirection,
  InteractionKind,
  RelationshipCategory,
  TimelineEntry,
} from '@timemark/shared';

/**
 * 个人 CRM（D4，plan todo 63）纯函数层。
 *
 * 时间线、节奏与到期判定都收敛在这里，组件只做渲染。所有函数对空值/畸形值
 * 都必须返回一个安全的缺省值（绝不抛错），因为后端可能返回 null 或非法字符串。
 * 不发明联系人评分/排名。
 */

/** 「记录联系」快捷动作（plan 只要求 call/message/meeting/meal 四个）。 */
export interface InteractionQuickAction {
  kind: InteractionKind;
  label: string;
}

export const INTERACTION_QUICK_ACTIONS: readonly InteractionQuickAction[] = [
  { kind: 'call', label: '打电话' },
  { kind: 'message', label: '发消息' },
  { kind: 'meeting', label: '见面' },
  { kind: 'meal', label: '聚餐' },
] as const;

export const INTERACTION_KIND_LABELS: Record<InteractionKind, string> = {
  call: '电话联系',
  message: '发消息',
  meeting: '见面',
  meal: '聚餐',
  visit: '登门拜访',
  gift: '礼物往来',
  other: '其他互动',
};

export function interactionKindLabel(kind: string | null | undefined): string {
  if (!kind) return '互动';
  return INTERACTION_KIND_LABELS[kind as InteractionKind] ?? '互动';
}

export const GIFT_DIRECTION_LABELS: Record<GiftDirection, string> = {
  given: '送出的礼物',
  received: '收到的礼物',
};

export function giftDirectionLabel(direction: string | null | undefined): string {
  if (direction === 'given' || direction === 'received') return GIFT_DIRECTION_LABELS[direction];
  return '礼物';
}

export const RELATIONSHIP_CATEGORY_LABELS: Record<RelationshipCategory, string> = {
  family: '家人',
  spouse: '配偶',
  child: '子女',
  relative: '亲属',
  friend: '朋友',
  colleague: '同事',
  other: '其他',
};

export function relationshipCategoryLabel(category: RelationshipCategory | null | undefined): string {
  if (!category) return '其他';
  return RELATIONSHIP_CATEGORY_LABELS[category] ?? '其他';
}

const CADENCE_LABELS: Record<number, string> = {
  7: '每周',
  14: '每两周',
  30: '每月',
  60: '每两个月',
  90: '每季度',
  180: '每半年',
  365: '每年',
};

/** 把节奏天数渲染成人类可读的标签；null/非法 → 未设置。 */
export function formatCadenceLabel(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days) || days <= 0) return '未设置';
  return CADENCE_LABELS[days] ?? `每 ${Math.floor(days)} 天`;
}

/** 本地时区的 YYYY-MM-DD；空/非法 → 空串。 */
export function formatYmdLocal(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 本地时区的 `YYYY-MM-DD HH:mm`；空/非法 → 空串。 */
export function formatTimelineAt(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${formatYmdLocal(value)} ${hh}:${mm}`;
}

/** 在给定时间上加 N 天，返回 ISO；空/非法 → null。 */
export function addDaysIso(
  at: string | null | undefined,
  days: number | null | undefined,
): string | null {
  if (!at || days == null || !Number.isFinite(days)) return null;
  const base = new Date(at);
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + days * 86_400_000).toISOString();
}

/** 距离目标时间的天数（向上取整）；空/非法 → null。 */
export function daysUntil(target: string | null | undefined, now: Date = new Date()): number | null {
  if (!target) return null;
  const t = new Date(target).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now.getTime()) / 86_400_000);
}

/** 目标时间已到/已过则视为到期；空/非法 → false。 */
export function isCadenceDue(nextDueAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!nextDueAt) return false;
  const t = new Date(nextDueAt).getTime();
  if (Number.isNaN(t)) return false;
  return t <= now.getTime();
}

/** 时间线（已按时间倒序）中最新一次互动的时间；没有 → null。 */
export function latestInteractionAt(entries: readonly TimelineEntry[]): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    if (entry.type !== 'interaction' || !entry.at) continue;
    if (!latest || new Date(entry.at).getTime() > new Date(latest).getTime()) latest = entry.at;
  }
  return latest;
}

/** 金额（整数分）→ `¥12.34`；空/非法 → null。 */
export function formatAmountCents(value: string | number | null | undefined): string | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return `¥${(n / 100).toFixed(2)}`;
}

export function timelineEntryTitle(entry: TimelineEntry): string {
  switch (entry.type) {
    case 'interaction':
      return interactionKindLabel(entry.interaction_kind);
    case 'promise':
      return '约定';
    case 'gift':
      return giftDirectionLabel(entry.direction);
  }
}

export function timelineEntryBody(entry: TimelineEntry): string {
  switch (entry.type) {
    case 'interaction':
      return entry.summary?.trim() || '已记录一次互动';
    case 'promise':
      return entry.promise_text?.trim() || '（无内容）';
    case 'gift': {
      const parts: string[] = [];
      if (entry.gift_description?.trim()) parts.push(entry.gift_description.trim());
      if (entry.occasion?.trim()) parts.push(entry.occasion.trim());
      const amount = formatAmountCents(entry.amount_cents);
      if (amount) parts.push(amount);
      return parts.join(' · ') || '礼物往来';
    }
  }
}

/** 约定条目的截止/完成氛围文案（只读：后端暂无完成接口）。 */
export function promiseStatusText(entry: TimelineEntry): string | null {
  if (entry.type !== 'promise') return null;
  if (entry.done_at) return `已于 ${formatYmdLocal(entry.done_at)} 完成`;
  if (entry.due_at) return `截止 ${formatYmdLocal(entry.due_at)}`;
  return '无期限';
}

/** 派生「下次联系」时间：有效最后联系 + 节奏天数；任一无值 → null。 */
export function computeNextDueAt(
  effectiveLastContactAt: string | null | undefined,
  cadenceDays: number | null | undefined,
): string | null {
  return addDaysIso(effectiveLastContactAt, cadenceDays);
}
