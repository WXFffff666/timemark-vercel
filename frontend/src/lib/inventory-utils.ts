/**
 * 库存（D12）前端纯函数工具。
 *
 * 只依赖 Wire 形状（蛇形命名，对齐 backend/src/services/inventory.service.ts 的
 * `InventoryItem`）与到期倒计时工具；不含 React、不发请求，因此可以直接单测
 * 「无 expires_at 必须渲染无保质期而不是 NaN」「低库存阈值判定不可反转」等失败场景。
 */
import { calculateCountdown } from './countdown';
import { formatExpiryCountdown, parseLocalYmd, type ExpiryCountdownKind } from './expiry-utils';

export interface InventoryItem {
  id: number;
  user_id: number;
  profile_id: number | null;
  name: string;
  category: string;
  quantity: number;
  unit: string | null;
  low_stock_threshold: number | null;
  purchased_at: string | null;
  expires_at: string | null;
  location: string | null;
  notes: string | null;
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export const INVENTORY_CATEGORY_LABELS: Record<string, string> = {
  food: '食品',
  medicine: '药品',
  supply: '耗材',
  other: '其它',
};

/** 稳定分组顺序：与 shared INVENTORY_CATEGORIES 对齐，未知分类回退到其它之后。 */
export const INVENTORY_CATEGORY_ORDER: readonly string[] = ['food', 'medicine', 'supply', 'other'];

/** 未知 category（API 返回脏数据）→ 回退为原字符串，绝不崩溃。 */
export function categoryLabel(category: string | null | undefined): string {
  if (!category) return '其它';
  return INVENTORY_CATEGORY_LABELS[category] ?? category;
}

/**
 * 低库存判定：quantity <= low_stock_threshold 且阈值非空。
 * 阈值 null（不跟踪）的行永远不是低库存。判定方向不可反转——
 * 一旦写成 `quantity >= threshold`，「消耗到阈值以下」就不会点亮徽章。
 */
export function isLowStock(item: Pick<InventoryItem, 'quantity' | 'low_stock_threshold'>): boolean {
  const threshold = item.low_stock_threshold;
  const quantity = item.quantity;
  if (threshold == null || typeof threshold !== 'number' || !Number.isFinite(threshold)) return false;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) return false;
  return quantity <= threshold;
}

/** 数量 + 单位；非法数量 → '—'（绝不 parseInt 出 NaN）。 */
export function formatQuantity(
  quantity: number | null | undefined,
  unit: string | null | undefined,
): string {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) return '—';
  const text = Number.isInteger(quantity) ? String(quantity) : String(Number(quantity.toFixed(3)));
  return unit ? `${text} ${unit}` : text;
}

export type InventoryExpiryKind = ExpiryCountdownKind | 'none';

export interface InventoryExpiryText {
  kind: InventoryExpiryKind;
  /** 无 expires_at → '无保质期'（绝不产出 Invalid Date / NaN）。 */
  text: string;
}

/**
 * 列表展示的保质期文案。无 / 非法 expires_at 一律返回 `{ kind: 'none', text: '无保质期' }`，
 * 这是「非易腐品」与「脏数据」共同的安全渲染路径。
 */
export function inventoryExpiryText(
  expiresAt: string | null | undefined,
  now: Date,
): InventoryExpiryText {
  const target = parseLocalYmd(expiresAt);
  if (!target) return { kind: 'none', text: '无保质期' };
  const countdown = calculateCountdown(target, now);
  const formatted = formatExpiryCountdown(countdown);
  return { kind: formatted.kind, text: formatted.text };
}

/** 按分类分组；未知分类追加到末尾，保持 INVENTORY_CATEGORY_ORDER 的稳定顺序。 */
export function groupByCategory(items: readonly InventoryItem[]): Array<{ category: string; items: InventoryItem[] }> {
  const buckets = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const key = item.category && INVENTORY_CATEGORY_LABELS[item.category] ? item.category : 'other';
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }
  const ordered: Array<{ category: string; items: InventoryItem[] }> = [];
  for (const category of INVENTORY_CATEGORY_ORDER) {
    const list = buckets.get(category);
    if (list) ordered.push({ category, items: list });
  }
  for (const [category, list] of buckets) {
    if (!INVENTORY_CATEGORY_ORDER.includes(category)) ordered.push({ category, items: list });
  }
  return ordered;
}

/** 低库存行数（依赖 isLowStock，便于汇总卡片与断言共用同一判定）。 */
export function countLowStock(items: readonly InventoryItem[]): number {
  return items.filter((item) => isLowStock(item)).length;
}
