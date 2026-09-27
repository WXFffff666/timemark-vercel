import { query } from '../db/index.js';
import {
  advanceExpiryDate,
  normalizeMonthlyCostCents,
  toYmdString,
} from '@timemark/shared';
import type { CreateExpiryItemInput, UpdateExpiryItemInput } from '@timemark/shared';

/**
 * 到期项数据访问层（D1）。
 *
 * 所有读写都由 user_id 限定：跨用户访问在 SQL 层就不可能命中，
 * 路由对「不存在」与「他人的行」统一返回 404（避免存在性泄露）。
 */

export interface ExpiryItemFilters {
  kind?: string;
  active?: boolean;
  /** next_due_date >= from (YYYY-MM-DD) */
  from?: string;
  /** next_due_date <= to (YYYY-MM-DD) */
  to?: string;
  /** title / vendor 子串（大小写不敏感） */
  q?: string;
  /** 家庭档案过滤（v41）：省略 = 全部档案，predicate 由路由做归属校验后传入 */
  profileId?: number | null;
}

export interface ExpiryItem {
  id: number;
  user_id: number;
  profile_id: number | null;
  kind: string;
  title: string;
  vendor: string | null;
  amount_cents: number | null;
  currency: string;
  cycle: string;
  cycle_days: number | null;
  start_date: string | null;
  next_due_date: string | null;
  auto_renew: boolean;
  notes: string | null;
  tags: string[];
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface ExpiryHistoryEntry {
  id: number;
  item_id: number;
  action: string;
  from_date: string | null;
  to_date: string | null;
  amount_cents: number | null;
  created_at: string | null;
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

export function serializeExpiryItem(row: RawRow): ExpiryItem {
  const reminderConfig = row.reminder_config;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    profile_id: toNumberOrNull(row.profile_id),
    kind: String(row.kind),
    title: String(row.title),
    vendor: row.vendor == null ? null : String(row.vendor),
    // pg 返回 BIGINT 为字符串：统一转 number，负数不可能（迁移有 CHECK / Zod 有 min(0)）
    amount_cents: toNumberOrNull(row.amount_cents),
    currency: String(row.currency ?? 'CNY').toUpperCase(),
    cycle: String(row.cycle ?? 'once'),
    cycle_days: toNumberOrNull(row.cycle_days),
    start_date: toYmdString(row.start_date),
    next_due_date: toYmdString(row.next_due_date),
    auto_renew: row.auto_renew === true,
    notes: row.notes == null ? null : String(row.notes),
    tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map(String) : [],
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

export function serializeExpiryHistory(row: RawRow): ExpiryHistoryEntry {
  return {
    id: Number(row.id),
    item_id: Number(row.item_id),
    action: String(row.action),
    from_date: toYmdString(row.from_date),
    to_date: toYmdString(row.to_date),
    amount_cents: toNumberOrNull(row.amount_cents),
    created_at: toIsoOrNull(row.created_at),
  };
}

export async function listExpiryItems(
  userId: number,
  filters: ExpiryItemFilters,
  page: number,
  limit: number,
): Promise<{ items: ExpiryItem[]; total: number }> {
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];

  // 可选档案过滤（checkbox 69）：省略 = 全部档案。只加谓词，不改写原查询。
  if (filters.profileId != null) {
    params.push(filters.profileId);
    where.push(`profile_id = $${params.length}`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    where.push(`kind = $${params.length}`);
  }
  if (filters.active !== undefined) {
    params.push(filters.active);
    where.push(`is_active = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`next_due_date >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`next_due_date <= $${params.length}::date`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(title ILIKE $${params.length} OR vendor ILIKE $${params.length})`);
  }

  const whereSql = where.join(' AND ');
  const offset = (page - 1) * limit;

  const totalResult = await query(
    `SELECT COUNT(*)::int AS count FROM expiry_items WHERE ${whereSql}`,
    params,
  );
  const rows = await query(
    `SELECT * FROM expiry_items WHERE ${whereSql}
     ORDER BY next_due_date ASC NULLS LAST, id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    items: rows.rows.map((row) => serializeExpiryItem(row as RawRow)),
    total: Number(totalResult.rows[0]?.count ?? 0),
  };
}

export async function getExpiryItem(userId: number, id: number): Promise<ExpiryItem | null> {
  const result = await query(
    'SELECT * FROM expiry_items WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  const row = result.rows[0];
  return row ? serializeExpiryItem(row as RawRow) : null;
}

export async function createExpiryItem(
  userId: number,
  input: CreateExpiryItemInput,
): Promise<ExpiryItem> {
  const result = await query(
    `INSERT INTO expiry_items (
       user_id, profile_id, kind, title, vendor, amount_cents, currency, cycle, cycle_days,
       start_date, next_due_date, auto_renew, notes, tags, reminder_config, is_active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      userId,
      input.profileId ?? null,
      input.kind,
      input.title,
      input.vendor ?? null,
      input.amountCents ?? null,
      (input.currency ?? 'CNY').toUpperCase(),
      input.cycle ?? 'once',
      input.cycleDays ?? null,
      input.startDate ?? null,
      input.nextDueDate,
      input.autoRenew ?? false,
      input.notes ?? null,
      input.tags ?? [],
      input.reminderConfig ? JSON.stringify(input.reminderConfig) : null,
      input.isActive ?? true,
    ],
  );
  return serializeExpiryItem(result.rows[0] as RawRow);
}

export async function updateExpiryItem(
  userId: number,
  id: number,
  patch: UpdateExpiryItemInput,
): Promise<ExpiryItem | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, userId];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.profileId !== undefined) push('profile_id', patch.profileId ?? null);
  if (patch.kind !== undefined) push('kind', patch.kind);
  if (patch.title !== undefined) push('title', patch.title);
  if (patch.vendor !== undefined) push('vendor', patch.vendor ?? null);
  if (patch.amountCents !== undefined) push('amount_cents', patch.amountCents ?? null);
  if (patch.currency !== undefined) push('currency', (patch.currency ?? 'CNY').toUpperCase());
  if (patch.cycle !== undefined) push('cycle', patch.cycle);
  if (patch.cycleDays !== undefined) push('cycle_days', patch.cycleDays ?? null);
  if (patch.startDate !== undefined) push('start_date', patch.startDate ?? null);
  if (patch.nextDueDate !== undefined) push('next_due_date', patch.nextDueDate);
  if (patch.autoRenew !== undefined) push('auto_renew', patch.autoRenew);
  if (patch.notes !== undefined) push('notes', patch.notes ?? null);
  if (patch.tags !== undefined) push('tags', patch.tags ?? []);
  if (patch.reminderConfig !== undefined) {
    push('reminder_config', patch.reminderConfig ? JSON.stringify(patch.reminderConfig) : null);
  }
  if (patch.isActive !== undefined) push('is_active', patch.isActive);

  if (sets.length === 0) {
    // No-op patch: still verify ownership so a foreign id stays a 404.
    return getExpiryItem(userId, id);
  }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  const result = await query(
    `UPDATE expiry_items SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params,
  );
  const row = result.rows[0];
  return row ? serializeExpiryItem(row as RawRow) : null;
}

export async function deleteExpiryItem(userId: number, id: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM expiry_items WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export type RenewExpiryResult =
  | { status: 'ok'; item: ExpiryItem; history: ExpiryHistoryEntry }
  | { status: 'not_found' }
  | { status: 'not_renewable'; item: ExpiryItem };

/**
 * 续期：推进 next_due_date 并写入 expiry_history（可审计）。
 * `once`（一次性）不可续期 → not_renewable；他人的行 → not_found（404）。
 */
export async function renewExpiryItem(userId: number, id: number): Promise<RenewExpiryResult> {
  const item = await getExpiryItem(userId, id);
  if (!item) return { status: 'not_found' };
  if (!item.next_due_date) return { status: 'not_renewable', item };

  const nextDue = advanceExpiryDate(item.next_due_date, item.cycle, item.cycle_days);
  if (!nextDue) return { status: 'not_renewable', item };

  const updated = await query(
    `UPDATE expiry_items SET next_due_date = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND user_id = $3 RETURNING *`,
    [nextDue, id, userId],
  );
  const history = await query(
    `INSERT INTO expiry_history (item_id, action, from_date, to_date, amount_cents)
     VALUES ($1, 'renew', $2, $3, $4) RETURNING *`,
    [id, item.next_due_date, nextDue, item.amount_cents],
  );

  return {
    status: 'ok',
    item: serializeExpiryItem(updated.rows[0] as RawRow),
    history: serializeExpiryHistory(history.rows[0] as RawRow),
  };
}

export type ExpiryCostGranularity = 'month' | 'year';

export interface ExpiryCostsResult {
  /** 周期成本的每月折算总额；仅当存在单一货币时有意义（混合货币为 0，见 byCurrency） */
  totalCents: number;
  currency: string | null;
  mixedCurrencies: boolean;
  /** 各货币的每月折算周期成本（分）——绝不跨货币求和 */
  byCurrency: Record<string, number>;
  byKind: Array<{ kind: string; currency: string; cents: number; count: number }>;
  monthly: Array<{ month: string; currency: string; cents: number }>;
  /** 一次性支出：不计入周期总额，单独列出 */
  once: { totalCents: number; currency: string | null; byCurrency: Record<string, number>; count: number };
}

/**
 * 成本聚合：把周期折算为「每月成本」，按货币与 kind 分组。
 * - 货币从不混合求和（byCurrency / byKind.currency / monthly.currency 三个维度都带货币）
 * - once 不计入 totalCents / byKind / monthly，只在 once 块列出
 * - 混合货币时 totalCents = 0 并置 mixedCurrencies = true（客户端必须读 byCurrency）
 */
export async function getExpiryCosts(
  userId: number,
  options: { granularity: ExpiryCostGranularity; from?: string; to?: string },
): Promise<ExpiryCostsResult> {
  const result = await query(
    `SELECT kind, amount_cents, currency, cycle, cycle_days, next_due_date
     FROM expiry_items
     WHERE user_id = $1 AND is_active = TRUE
       AND ($2::date IS NULL OR next_due_date >= $2::date)
       AND ($3::date IS NULL OR next_due_date <= $3::date)
     ORDER BY next_due_date ASC NULLS LAST, id ASC`,
    [userId, options.from ?? null, options.to ?? null],
  );

  const byCurrency: Record<string, number> = {};
  const byKindMap = new Map<string, { kind: string; currency: string; cents: number; count: number }>();
  const monthlyMap = new Map<string, { month: string; currency: string; cents: number }>();
  const onceByCurrency: Record<string, number> = {};
  let onceCount = 0;

  for (const raw of result.rows) {
    const row = raw as RawRow;
    const kind = String(row.kind);
    const currency = String(row.currency ?? 'CNY').toUpperCase();
    const amount = toNumberOrNull(row.amount_cents);
    const cycle = String(row.cycle ?? 'once');
    const cycleDays = toNumberOrNull(row.cycle_days);
    const due = toYmdString(row.next_due_date);
    const monthlyCents = normalizeMonthlyCostCents(amount, cycle, cycleDays);

    if (monthlyCents == null) {
      // once / 无法折算的 custom：单独列出，绝不混入周期总额
      onceCount += 1;
      if (amount != null) {
        onceByCurrency[currency] = (onceByCurrency[currency] ?? 0) + amount;
      }
      continue;
    }

    byCurrency[currency] = (byCurrency[currency] ?? 0) + monthlyCents;

    const kindKey = `${kind}::${currency}`;
    const kindEntry = byKindMap.get(kindKey) ?? { kind, currency, cents: 0, count: 0 };
    kindEntry.cents += monthlyCents;
    kindEntry.count += 1;
    byKindMap.set(kindKey, kindEntry);

    if (due) {
      const bucket = options.granularity === 'year' ? due.slice(0, 4) : due.slice(0, 7);
      const monthKey = `${bucket}::${currency}`;
      const monthEntry = monthlyMap.get(monthKey) ?? { month: bucket, currency, cents: 0 };
      monthEntry.cents += monthlyCents;
      monthlyMap.set(monthKey, monthEntry);
    }
  }

  const currencies = Object.keys(byCurrency);
  const onceCurrencies = Object.keys(onceByCurrency);
  const single = currencies.length === 1 ? currencies[0] : null;
  const singleOnce = onceCurrencies.length === 1 ? onceCurrencies[0] : null;

  return {
    totalCents: single ? byCurrency[single] : 0,
    currency: single,
    mixedCurrencies: currencies.length > 1,
    byCurrency,
    byKind: [...byKindMap.values()].sort((a, b) =>
      a.kind === b.kind ? a.currency.localeCompare(b.currency) : a.kind.localeCompare(b.kind),
    ),
    monthly: [...monthlyMap.values()].sort((a, b) =>
      a.month === b.month ? a.currency.localeCompare(b.currency) : a.month.localeCompare(b.month),
    ),
    once: {
      totalCents: singleOnce ? onceByCurrency[singleOnce] : 0,
      currency: singleOnce,
      byCurrency: onceByCurrency,
      count: onceCount,
    },
  };
}

/** 供 /api/stats 的 expiry 块使用：计数汇总（含逾期与 7 天内到期） */
export async function getExpirySummary(userId: number): Promise<{
  total: number;
  active: number;
  overdue: number;
  dueSoon: number;
}> {
  const result = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE is_active)::int AS active,
       COUNT(*) FILTER (WHERE is_active AND next_due_date < CURRENT_DATE)::int AS overdue,
       COUNT(*) FILTER (WHERE is_active AND next_due_date >= CURRENT_DATE
                          AND next_due_date <= CURRENT_DATE + INTERVAL '7 days')::int AS due_soon
     FROM expiry_items WHERE user_id = $1`,
    [userId],
  );
  const row = (result.rows[0] ?? {}) as RawRow;
  return {
    total: Number(row.total ?? 0),
    active: Number(row.active ?? 0),
    overdue: Number(row.overdue ?? 0),
    dueSoon: Number(row.due_soon ?? 0),
  };
}

/** 供 /api/expiry/upcoming 使用：days 天（含今天）内到期 */
export async function listUpcomingExpiryItems(userId: number, days: number): Promise<ExpiryItem[]> {
  const result = await query(
    `SELECT * FROM expiry_items
     WHERE user_id = $1 AND is_active = TRUE
       AND next_due_date >= CURRENT_DATE
       AND next_due_date <= CURRENT_DATE + ($2::int * INTERVAL '1 day')
     ORDER BY next_due_date ASC, id ASC`,
    [userId, days],
  );
  return result.rows.map((row) => serializeExpiryItem(row as RawRow));
}

/** 供 /api/expiry/overdue 使用：已过期且仍激活 */
export async function listOverdueExpiryItems(userId: number): Promise<ExpiryItem[]> {
  const result = await query(
    `SELECT * FROM expiry_items
     WHERE user_id = $1 AND is_active = TRUE AND next_due_date < CURRENT_DATE
     ORDER BY next_due_date ASC, id ASC`,
    [userId],
  );
  return result.rows.map((row) => serializeExpiryItem(row as RawRow));
}
