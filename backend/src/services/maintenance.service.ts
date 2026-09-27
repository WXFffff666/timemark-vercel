import { query } from '../db/index.js';
import { computeNextDueAt, computeNextDueUsage, toYmdString } from '@timemark/shared';
import type {
  CreateMaintenancePlanInput,
  RecordMaintenanceLogInput,
  UpdateMaintenancePlanInput,
} from '@timemark/shared';

/**
 * 保养计划数据访问层（D12）。
 *
 * - 所有读写由 user_id 限定；「不存在」与「他人的行」都是 404（防存在性泄露）
 * - `POST /:id/log` 记录保养并重算：next_due_at = 最新 done_at + interval_days，
 *   next_due_usage = 最新 usage_at + interval_usage；补记旧日期不会把计划倒推
 *   （总是取「最新一次」保养）
 * - 两个间隔都为空的计划在创建时被 Zod 拒绝、在更新时由服务层拒绝
 */
export interface MaintenancePlanFilters {
  assetKind?: string;
  active?: boolean;
  /** asset_name 子串（大小写不敏感） */
  q?: string;
  /** 家庭档案过滤（v41）：省略 = 全部档案，predicate 由路由做归属校验后传入 */
  profileId?: number | null;
}

export interface MaintenancePlan {
  id: number;
  user_id: number;
  profile_id: number | null;
  asset_name: string;
  asset_kind: string;
  interval_days: number | null;
  interval_usage: number | null;
  usage_unit: string | null;
  current_usage: number | null;
  last_done_at: string | null;
  next_due_at: string | null;
  next_due_usage: number | null;
  notes: string | null;
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface MaintenanceLogEntry {
  id: number;
  plan_id: number;
  done_at: string | null;
  usage_at: number | null;
  cost_cents: number | null;
  notes: string | null;
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

function parseReminderConfig(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (raw) return JSON.parse(String(raw)) as Record<string, unknown>;
  return null;
}

export function serializeMaintenancePlan(row: RawRow): MaintenancePlan {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    profile_id: toNumberOrNull(row.profile_id),
    asset_name: String(row.asset_name),
    asset_kind: String(row.asset_kind ?? 'other'),
    interval_days: toNumberOrNull(row.interval_days),
    interval_usage: toNumberOrNull(row.interval_usage),
    usage_unit: row.usage_unit == null ? null : String(row.usage_unit),
    current_usage: toNumberOrNull(row.current_usage),
    last_done_at: toYmdString(row.last_done_at),
    next_due_at: toYmdString(row.next_due_at),
    next_due_usage: toNumberOrNull(row.next_due_usage),
    notes: row.notes == null ? null : String(row.notes),
    reminder_config: parseReminderConfig(row.reminder_config),
    is_active: row.is_active !== false,
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at),
  };
}

export function serializeMaintenanceLog(row: RawRow): MaintenanceLogEntry {
  return {
    id: Number(row.id),
    plan_id: Number(row.plan_id),
    done_at: toYmdString(row.done_at),
    usage_at: toNumberOrNull(row.usage_at),
    cost_cents: toNumberOrNull(row.cost_cents),
    notes: row.notes == null ? null : String(row.notes),
    created_at: toIsoOrNull(row.created_at),
  };
}

export async function listMaintenancePlans(
  userId: number,
  filters: MaintenancePlanFilters,
  page: number,
  limit: number,
): Promise<{ items: MaintenancePlan[]; total: number }> {
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];

  // 可选档案过滤（checkbox 69）：省略 = 全部档案。只加谓词，不改写原查询。
  if (filters.profileId != null) {
    params.push(filters.profileId);
    where.push(`profile_id = $${params.length}`);
  }
  if (filters.assetKind) {
    params.push(filters.assetKind);
    where.push(`asset_kind = $${params.length}`);
  }
  if (filters.active !== undefined) {
    params.push(filters.active);
    where.push(`is_active = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`asset_name ILIKE $${params.length}`);
  }

  const whereSql = where.join(' AND ');
  const offset = (page - 1) * limit;

  const totalResult = await query(
    `SELECT COUNT(*)::int AS count FROM maintenance_plans WHERE ${whereSql}`,
    params,
  );
  const rows = await query(
    `SELECT * FROM maintenance_plans WHERE ${whereSql}
     ORDER BY next_due_at ASC NULLS LAST, id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    items: rows.rows.map((row) => serializeMaintenancePlan(row as RawRow)),
    total: Number(totalResult.rows[0]?.count ?? 0),
  };
}

export async function getMaintenancePlan(userId: number, id: number): Promise<MaintenancePlan | null> {
  const result = await query('SELECT * FROM maintenance_plans WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = result.rows[0];
  return row ? serializeMaintenancePlan(row as RawRow) : null;
}

export async function createMaintenancePlan(
  userId: number,
  input: CreateMaintenancePlanInput,
): Promise<MaintenancePlan> {
  const result = await query(
    `INSERT INTO maintenance_plans (
       user_id, profile_id, asset_name, asset_kind, interval_days, interval_usage, usage_unit,
       current_usage, last_done_at, next_due_at, next_due_usage, notes, reminder_config, is_active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      userId,
      input.profileId ?? null,
      input.assetName,
      input.assetKind ?? 'other',
      input.intervalDays ?? null,
      input.intervalUsage ?? null,
      input.usageUnit ?? null,
      input.currentUsage ?? null,
      input.lastDoneAt ?? null,
      input.nextDueAt ?? null,
      input.nextDueUsage ?? null,
      input.notes ?? null,
      input.reminderConfig ? JSON.stringify(input.reminderConfig) : null,
      input.isActive ?? true,
    ],
  );
  return serializeMaintenancePlan(result.rows[0] as RawRow);
}

export type UpdateMaintenanceResult =
  | { status: 'ok'; plan: MaintenancePlan }
  | { status: 'not_found' }
  | { status: 'no_interval' };

/**
 * 更新计划。间隔变更时先合并库中现值再校验「至少一个间隔」——
 * Zod 的 partial schema 无法看到旧值，所以这个守卫必须在服务层。
 */
export async function updateMaintenancePlan(
  userId: number,
  id: number,
  patch: UpdateMaintenancePlanInput,
): Promise<UpdateMaintenanceResult> {
  const touchesIntervals = patch.intervalDays !== undefined || patch.intervalUsage !== undefined;
  let existing: MaintenancePlan | null = null;

  if (touchesIntervals) {
    existing = await getMaintenancePlan(userId, id);
    if (!existing) return { status: 'not_found' };
    const mergedDays = patch.intervalDays !== undefined ? patch.intervalDays : existing.interval_days;
    const mergedUsage = patch.intervalUsage !== undefined ? patch.intervalUsage : existing.interval_usage;
    if (mergedDays == null && mergedUsage == null) return { status: 'no_interval' };
  }

  const sets: string[] = [];
  const params: unknown[] = [id, userId];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.profileId !== undefined) push('profile_id', patch.profileId ?? null);
  if (patch.assetName !== undefined) push('asset_name', patch.assetName);
  if (patch.assetKind !== undefined) push('asset_kind', patch.assetKind);
  if (patch.intervalDays !== undefined) push('interval_days', patch.intervalDays ?? null);
  if (patch.intervalUsage !== undefined) push('interval_usage', patch.intervalUsage ?? null);
  if (patch.usageUnit !== undefined) push('usage_unit', patch.usageUnit ?? null);
  if (patch.currentUsage !== undefined) push('current_usage', patch.currentUsage ?? null);
  if (patch.lastDoneAt !== undefined) push('last_done_at', patch.lastDoneAt ?? null);
  if (patch.nextDueAt !== undefined) push('next_due_at', patch.nextDueAt ?? null);
  if (patch.nextDueUsage !== undefined) push('next_due_usage', patch.nextDueUsage ?? null);
  if (patch.notes !== undefined) push('notes', patch.notes ?? null);
  if (patch.reminderConfig !== undefined) {
    push('reminder_config', patch.reminderConfig ? JSON.stringify(patch.reminderConfig) : null);
  }
  if (patch.isActive !== undefined) push('is_active', patch.isActive);

  if (sets.length === 0) {
    // No-op patch: still verify ownership so a foreign id stays a 404.
    const item = await getMaintenancePlan(userId, id);
    return item ? { status: 'ok', plan: item } : { status: 'not_found' };
  }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  const result = await query(
    `UPDATE maintenance_plans SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params,
  );
  const row = result.rows[0];
  return row ? { status: 'ok', plan: serializeMaintenancePlan(row as RawRow) } : { status: 'not_found' };
}

export async function deleteMaintenancePlan(userId: number, id: number): Promise<boolean> {
  const result = await query('DELETE FROM maintenance_plans WHERE id = $1 AND user_id = $2', [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

/** 计划的服务历史（按计划归属校验 user_id；他人的计划 → null） */
export async function listMaintenanceLogs(
  userId: number,
  planId: number,
): Promise<MaintenanceLogEntry[] | null> {
  const plan = await getMaintenancePlan(userId, planId);
  if (!plan) return null;
  const result = await query(
    `SELECT l.* FROM maintenance_logs l
     JOIN maintenance_plans p ON p.id = l.plan_id
     WHERE l.plan_id = $1 AND p.user_id = $2
     ORDER BY l.done_at DESC, l.id DESC`,
    [planId, userId],
  );
  return result.rows.map((row) => serializeMaintenanceLog(row as RawRow));
}

export type RecordMaintenanceResult =
  | { status: 'ok'; plan: MaintenancePlan; log: MaintenanceLogEntry }
  | { status: 'not_found' }
  | { status: 'usage_required'; plan: MaintenancePlan };

/** 返回较晚的 YYYY-MM-DD（传给 null 时取另一个） */
function laterYmd(a: string | null, b: string): string {
  if (!a) return b;
  return a > b ? a : b;
}

function laterNumber(a: number | null, b: number): number {
  if (a == null) return b;
  return a > b ? a : b;
}

/**
 * 记录一次保养并重算计划：
 * - last_done_at / current_usage 取「最新」（补记旧记录不会倒推计划）
 * - next_due_at = 最新 done_at + interval_days（没有日期间隔则 null）
 * - next_due_usage = 最新 usage_at + interval_usage（没有用量间隔则 null）
 * - 计划带用量间隔但请求没有 usage_at → usage_required（400，绝不猜）
 */
export async function recordMaintenanceLog(
  userId: number,
  planId: number,
  input: RecordMaintenanceLogInput,
): Promise<RecordMaintenanceResult> {
  const plan = await getMaintenancePlan(userId, planId);
  if (!plan) return { status: 'not_found' };
  if (plan.interval_usage != null && input.usageAt == null) {
    return { status: 'usage_required', plan };
  }

  const effectiveDoneAt = laterYmd(plan.last_done_at, input.doneAt);
  const nextDueAt = plan.interval_days != null ? computeNextDueAt(effectiveDoneAt, plan.interval_days) : null;

  const effectiveUsageAt =
    input.usageAt == null ? plan.current_usage : laterNumber(plan.current_usage, input.usageAt);
  const nextDueUsage =
    plan.interval_usage != null ? computeNextDueUsage(effectiveUsageAt, plan.interval_usage) : null;

  const updated = await query(
    `UPDATE maintenance_plans
     SET last_done_at = $1, current_usage = $2, next_due_at = $3, next_due_usage = $4,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $5 AND user_id = $6 RETURNING *`,
    [effectiveDoneAt, effectiveUsageAt, nextDueAt, nextDueUsage, planId, userId],
  );

  const log = await query(
    `INSERT INTO maintenance_logs (plan_id, done_at, usage_at, cost_cents, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [planId, input.doneAt, input.usageAt ?? null, input.costCents ?? null, input.notes ?? null],
  );

  return {
    status: 'ok',
    plan: serializeMaintenancePlan(updated.rows[0] as RawRow),
    log: serializeMaintenanceLog(log.rows[0] as RawRow),
  };
}
