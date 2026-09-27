import { query } from '../db/index.js';
import { toYmdString } from '@timemark/shared';
import type { CreateInventoryItemInput, UpdateInventoryItemInput } from '@timemark/shared';

/**
 * 库存数据访问层（D12）。
 *
 * 所有读写都由 user_id 限定：跨用户访问在 SQL 层就不可能命中，
 * 路由对「不存在」与「他人的行」统一返回 404（避免存在性泄露）。
 * 消耗走单条带 `quantity >= $3` 守卫的 UPDATE，绝不静默夹到 0。
 */

export interface InventoryItemFilters {
  category?: string;
  active?: boolean;
  /** true = 只要 quantity <= low_stock_threshold 的行 */
  lowStock?: boolean;
  /** name / location 子串（大小写不敏感） */
  q?: string;
}

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

type RawRow = Record<string, unknown>;

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function serializeInventoryItem(row: RawRow): InventoryItem {
  const reminderConfig = row.reminder_config;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    profile_id: toNumberOrNull(row.profile_id),
    name: String(row.name),
    category: String(row.category ?? 'other'),
    // pg 返回 NUMERIC 为字符串：统一转 number
    quantity: toNumberOrNull(row.quantity) ?? 0,
    unit: row.unit == null ? null : String(row.unit),
    low_stock_threshold: toNumberOrNull(row.low_stock_threshold),
    purchased_at: toYmdString(row.purchased_at),
    // null = 非易腐品；序列化时保持 null，绝不伪造成日期
    expires_at: toYmdString(row.expires_at),
    location: row.location == null ? null : String(row.location),
    notes: row.notes == null ? null : String(row.notes),
    reminder_config:
      reminderConfig && typeof reminderConfig === 'object'
        ? (reminderConfig as Record<string, unknown>)
        : reminderConfig
          ? (JSON.parse(String(reminderConfig)) as Record<string, unknown>)
          : null,
    is_active: row.is_active !== false,
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at),
  };
}

export async function listInventoryItems(
  userId: number,
  filters: InventoryItemFilters,
  page: number,
  limit: number,
): Promise<{ items: InventoryItem[]; total: number }> {
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];

  if (filters.category) {
    params.push(filters.category);
    where.push(`category = $${params.length}`);
  }
  if (filters.active !== undefined) {
    params.push(filters.active);
    where.push(`is_active = $${params.length}`);
  }
  if (filters.lowStock === true) {
    where.push('low_stock_threshold IS NOT NULL AND quantity <= low_stock_threshold');
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(name ILIKE $${params.length} OR location ILIKE $${params.length})`);
  }

  const whereSql = where.join(' AND ');
  const offset = (page - 1) * limit;

  const totalResult = await query(
    `SELECT COUNT(*)::int AS count FROM inventory_items WHERE ${whereSql}`,
    params,
  );
  const rows = await query(
    `SELECT * FROM inventory_items WHERE ${whereSql}
     ORDER BY expires_at ASC NULLS LAST, id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    items: rows.rows.map((row) => serializeInventoryItem(row as RawRow)),
    total: Number(totalResult.rows[0]?.count ?? 0),
  };
}

export async function getInventoryItem(userId: number, id: number): Promise<InventoryItem | null> {
  const result = await query('SELECT * FROM inventory_items WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = result.rows[0];
  return row ? serializeInventoryItem(row as RawRow) : null;
}

export async function createInventoryItem(
  userId: number,
  input: CreateInventoryItemInput,
): Promise<InventoryItem> {
  const result = await query(
    `INSERT INTO inventory_items (
       user_id, profile_id, name, category, quantity, unit, low_stock_threshold,
       purchased_at, expires_at, location, notes, reminder_config, is_active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      userId,
      input.profileId ?? null,
      input.name,
      input.category ?? 'other',
      input.quantity ?? 1,
      input.unit ?? null,
      input.lowStockThreshold ?? null,
      input.purchasedAt ?? null,
      input.expiresAt ?? null,
      input.location ?? null,
      input.notes ?? null,
      input.reminderConfig ? JSON.stringify(input.reminderConfig) : null,
      input.isActive ?? true,
    ],
  );
  return serializeInventoryItem(result.rows[0] as RawRow);
}

export async function updateInventoryItem(
  userId: number,
  id: number,
  patch: UpdateInventoryItemInput,
): Promise<InventoryItem | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, userId];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.profileId !== undefined) push('profile_id', patch.profileId ?? null);
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.category !== undefined) push('category', patch.category);
  if (patch.quantity !== undefined) push('quantity', patch.quantity);
  if (patch.unit !== undefined) push('unit', patch.unit ?? null);
  if (patch.lowStockThreshold !== undefined) push('low_stock_threshold', patch.lowStockThreshold ?? null);
  if (patch.purchasedAt !== undefined) push('purchased_at', patch.purchasedAt ?? null);
  if (patch.expiresAt !== undefined) push('expires_at', patch.expiresAt ?? null);
  if (patch.location !== undefined) push('location', patch.location ?? null);
  if (patch.notes !== undefined) push('notes', patch.notes ?? null);
  if (patch.reminderConfig !== undefined) {
    push('reminder_config', patch.reminderConfig ? JSON.stringify(patch.reminderConfig) : null);
  }
  if (patch.isActive !== undefined) push('is_active', patch.isActive);

  if (sets.length === 0) {
    // No-op patch: still verify ownership so a foreign id stays a 404.
    return getInventoryItem(userId, id);
  }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  const result = await query(
    `UPDATE inventory_items SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params,
  );
  const row = result.rows[0];
  return row ? serializeInventoryItem(row as RawRow) : null;
}

export async function deleteInventoryItem(userId: number, id: number): Promise<boolean> {
  const result = await query('DELETE FROM inventory_items WHERE id = $1 AND user_id = $2', [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

export type ConsumeInventoryResult =
  | { status: 'ok'; item: InventoryItem }
  | { status: 'not_found' }
  | { status: 'insufficient'; item: InventoryItem };

/**
 * 消耗库存：单条 UPDATE 带 `quantity >= $3` 守卫，原子且绝不夹到 0。
 * - 守卫未命中且行存在 → insufficient（路由返回 400，绝不静默截断）
 * - 行不存在/不属于该用户 → not_found（路由 404）
 */
export async function consumeInventoryItem(
  userId: number,
  id: number,
  amount: number,
): Promise<ConsumeInventoryResult> {
  const updated = await query(
    `UPDATE inventory_items SET quantity = quantity - $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND user_id = $2 AND quantity >= $3
     RETURNING *`,
    [id, userId, amount],
  );
  const row = updated.rows[0];
  if (row) {
    return { status: 'ok', item: serializeInventoryItem(row as RawRow) };
  }

  const existing = await getInventoryItem(userId, id);
  if (!existing) return { status: 'not_found' };
  return { status: 'insufficient', item: existing };
}

/**
 * 即将到期（含已过期）：expires_at 非空且 <= 今天 + days。
 * - `expires_at IS NOT NULL` 是硬守卫：非易腐品（null）永不出现
 * - 已过期的行也返回（排最前），食品/药品过期了更需要看见
 */
export async function listExpiringInventoryItems(userId: number, days: number): Promise<InventoryItem[]> {
  const result = await query(
    `SELECT * FROM inventory_items
     WHERE user_id = $1 AND is_active = TRUE
       AND expires_at IS NOT NULL
       AND expires_at <= CURRENT_DATE + ($2::int * INTERVAL '1 day')
     ORDER BY expires_at ASC, id ASC`,
    [userId, days],
  );
  return result.rows
    .map((row) => serializeInventoryItem(row as RawRow))
    .filter((item) => item.expires_at !== null);
}

/**
 * 低库存：quantity <= low_stock_threshold（含等于）。
 * 阈值 NULL 的行不参与；SQL 之外再核一遍，做到「恰好是达到或低于阈值的行」。
 */
export async function listLowStockInventoryItems(userId: number): Promise<InventoryItem[]> {
  const result = await query(
    `SELECT * FROM inventory_items
     WHERE user_id = $1 AND is_active = TRUE
       AND low_stock_threshold IS NOT NULL
       AND quantity <= low_stock_threshold
     ORDER BY (quantity - low_stock_threshold) ASC, id ASC`,
    [userId],
  );
  return result.rows
    .map((row) => serializeInventoryItem(row as RawRow))
    .filter((item) => item.low_stock_threshold !== null && item.quantity <= item.low_stock_threshold);
}
