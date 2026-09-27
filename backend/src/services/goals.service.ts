import { query } from '../db/index.js';
import { GOAL_STATUSES, toYmdString } from '@timemark/shared';
import type {
  CreateGoalInput,
  CreateMilestoneInput,
  GoalRecord,
  GoalStatus,
  GoalWithMilestones,
  MilestoneRecord,
  UpdateGoalInput,
  UpdateMilestoneInput,
} from '@timemark/shared';

/**
 * 目标 / 里程碑数据访问层（checkbox 81）。
 *
 * 所有读写都由 user_id 限定（里程碑通过其 goal 归属校验）：跨用户访问在 SQL 层
 * 就不可能命中，路由对「不存在」与「他人的行」统一返回 404（避免存在性泄露）。
 *
 * 进度语义：
 * - `goals.current_value` 永远保存**原始值**（允许超过目标值，例如 150/100）；
 * - 只有派生字段 `progress` clamp 到 [0, 100]（保留 2 位小数），target_value 为
 *   NULL（纯里程碑目标）时为 null。
 * - 里程碑全部完成 **不会** 自动关闭目标：done 只能由显式 PATCH status 设置。
 *
 * 提醒语义：`milestones.event_id` 只是可选外键，指向既有 events；该事件的提醒由
 * 既有提醒引擎（jobs/tasks.ts）照常发出，本模块不新建第二个调度器。
 */

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

export function serializeMilestone(row: RawRow): MilestoneRecord {
  return {
    id: Number(row.id),
    goal_id: Number(row.goal_id),
    title: String(row.title ?? ''),
    due_at: toYmdString(row.due_at),
    done_at: toIsoOrNull(row.done_at),
    sort_order: Number(row.sort_order ?? 0),
    event_id: toNumberOrNull(row.event_id),
  };
}

/**
 * 派生进度百分比：clamp 到 [0, 100]，保留 2 位小数。
 * target_value 为 null / <= 0 时返回 null（无目标值就没有百分比）。
 */
export function computeGoalProgress(currentValue: number, targetValue: number | null): number | null {
  if (targetValue == null || targetValue <= 0) return null;
  const raw = (currentValue / targetValue) * 100;
  return Math.min(100, Math.round(raw * 100) / 100);
}

export function serializeGoal(row: RawRow, milestones: MilestoneRecord[] = []): GoalRecord {
  const currentValue = toNumberOrNull(row.current_value) ?? 0;
  const targetValue = toNumberOrNull(row.target_value);
  const rawStatus = String(row.status ?? 'active');
  const status = (GOAL_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as GoalStatus)
    : 'active';
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    profile_id: toNumberOrNull(row.profile_id),
    title: String(row.title ?? ''),
    description: row.description == null ? null : String(row.description),
    category: row.category == null ? null : String(row.category),
    target_value: targetValue,
    current_value: currentValue,
    unit: row.unit == null ? null : String(row.unit),
    start_date: toYmdString(row.start_date),
    target_date: toYmdString(row.target_date),
    status,
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at),
    progress: computeGoalProgress(currentValue, targetValue),
    milestone_count: milestones.length,
    milestone_done_count: milestones.filter((m) => m.done_at != null).length,
  };
}

export interface GoalFilters {
  status?: GoalStatus;
  /** 家庭档案过滤（v41）：省略 = 全部档案，归属校验由路由完成 */
  profileId?: number | null;
}

async function attachMilestones(goalRows: RawRow[]): Promise<GoalWithMilestones[]> {
  if (goalRows.length === 0) return [];
  const ids = goalRows.map((row) => Number(row.id));
  const result = await query(
    'SELECT * FROM milestones WHERE goal_id = ANY($1::int[]) ORDER BY sort_order ASC, id ASC',
    [ids],
  );
  const byGoal = new Map<number, MilestoneRecord[]>();
  for (const row of result.rows) {
    const milestone = serializeMilestone(row as RawRow);
    const list = byGoal.get(milestone.goal_id);
    if (list) list.push(milestone);
    else byGoal.set(milestone.goal_id, [milestone]);
  }
  return goalRows.map((row) => {
    const list = byGoal.get(Number(row.id)) ?? [];
    return { ...serializeGoal(row, list), milestones: list };
  });
}

export async function listGoals(userId: number, filters: GoalFilters = {}): Promise<GoalWithMilestones[]> {
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];
  if (filters.status != null) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.profileId != null) {
    params.push(filters.profileId);
    where.push(`profile_id = $${params.length}`);
  }
  const result = await query(
    `SELECT * FROM goals WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC`,
    params,
  );
  return attachMilestones(result.rows as RawRow[]);
}

export async function getGoal(userId: number, id: number): Promise<GoalWithMilestones | null> {
  const result = await query('SELECT * FROM goals WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = result.rows[0] as RawRow | undefined;
  if (!row) return null;
  const ms = await query(
    'SELECT * FROM milestones WHERE goal_id = $1 ORDER BY sort_order ASC, id ASC',
    [id],
  );
  const milestones = ms.rows.map((m) => serializeMilestone(m as RawRow));
  return { ...serializeGoal(row, milestones), milestones };
}

export async function createGoal(userId: number, input: CreateGoalInput): Promise<GoalWithMilestones> {
  const result = await query(
    `INSERT INTO goals
       (user_id, profile_id, title, description, category, target_value, current_value, unit, start_date, target_date, status)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 0), $8, COALESCE($9::date, CURRENT_DATE), $10, COALESCE($11, 'active'))
     RETURNING *`,
    [
      userId,
      input.profileId ?? null,
      input.title,
      input.description ?? null,
      input.category ?? null,
      input.targetValue ?? null,
      input.currentValue ?? null,
      input.unit ?? null,
      input.startDate ?? null,
      input.targetDate ?? null,
      input.status ?? null,
    ],
  );
  const row = result.rows[0] as RawRow;
  return { ...serializeGoal(row, []), milestones: [] };
}

export async function updateGoal(
  userId: number,
  id: number,
  input: UpdateGoalInput,
): Promise<GoalWithMilestones | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.title !== undefined) {
    updates.push(`title = $${paramIndex++}`);
    values.push(input.title);
  }
  if (input.description !== undefined) {
    updates.push(`description = $${paramIndex++}`);
    values.push(input.description ?? null);
  }
  if (input.category !== undefined) {
    updates.push(`category = $${paramIndex++}`);
    values.push(input.category ?? null);
  }
  if (input.targetValue !== undefined) {
    updates.push(`target_value = $${paramIndex++}`);
    values.push(input.targetValue ?? null);
  }
  if (input.currentValue !== undefined) {
    updates.push(`current_value = $${paramIndex++}`);
    values.push(input.currentValue);
  }
  if (input.unit !== undefined) {
    updates.push(`unit = $${paramIndex++}`);
    values.push(input.unit ?? null);
  }
  if (input.startDate !== undefined) {
    updates.push(`start_date = $${paramIndex++}`);
    values.push(input.startDate);
  }
  if (input.targetDate !== undefined) {
    updates.push(`target_date = $${paramIndex++}`);
    values.push(input.targetDate ?? null);
  }
  if (input.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(input.status);
  }
  if (input.profileId !== undefined) {
    updates.push(`profile_id = $${paramIndex++}`);
    values.push(input.profileId ?? null);
  }

  if (updates.length === 0) {
    return getGoal(userId, id);
  }

  const result = await query(
    `UPDATE goals SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${paramIndex++} AND user_id = $${paramIndex}
     RETURNING id`,
    [...values, id, userId],
  );
  if (!result.rows[0]) return null;
  return getGoal(userId, id);
}

/** 设置原始当前值：写库不做 clamp（可以超过 target_value），clamp 只作用于 progress */
export async function setGoalProgress(
  userId: number,
  id: number,
  currentValue: number,
): Promise<GoalWithMilestones | null> {
  const result = await query(
    'UPDATE goals SET current_value = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3 RETURNING id',
    [currentValue, id, userId],
  );
  if (!result.rows[0]) return null;
  return getGoal(userId, id);
}

/**
 * 删除目标。里程碑由数据库外键 ON DELETE CASCADE 一并删除；
 * 里程碑上关联的事件（milestones.event_id）不受任何影响（事件行的存在性由本操作之外的
 * events 生命周期决定）—— 本函数不发出任何针对 events 的写语句。
 */
export async function deleteGoal(userId: number, id: number): Promise<boolean> {
  const result = await query('DELETE FROM goals WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return result.rows.length > 0;
}

export type MilestoneMutationResult =
  | { status: 'ok'; milestone: MilestoneRecord }
  | { status: 'goal_not_found' }
  | { status: 'milestone_not_found' }
  | { status: 'event_not_found' };

async function goalExists(userId: number, goalId: number): Promise<boolean> {
  const result = await query('SELECT id FROM goals WHERE id = $1 AND user_id = $2', [goalId, userId]);
  return result.rows.length > 0;
}

/** 关联事件必须属于当前用户（他人的 / 不存在的都是 false，路由统一 404） */
export async function findOwnedEvent(userId: number, eventId: number): Promise<boolean> {
  const result = await query('SELECT 1 FROM events WHERE id = $1 AND user_id = $2', [eventId, userId]);
  return result.rows.length > 0;
}

export async function createMilestone(
  userId: number,
  goalId: number,
  input: CreateMilestoneInput,
): Promise<MilestoneMutationResult> {
  if (!(await goalExists(userId, goalId))) return { status: 'goal_not_found' };
  if (input.eventId != null && !(await findOwnedEvent(userId, input.eventId))) {
    return { status: 'event_not_found' };
  }
  const result = await query(
    `INSERT INTO milestones (goal_id, title, due_at, sort_order, event_id)
     VALUES ($1, $2, $3, COALESCE($4, 0), $5)
     RETURNING *`,
    [goalId, input.title, input.dueAt ?? null, input.sortOrder ?? null, input.eventId ?? null],
  );
  return { status: 'ok', milestone: serializeMilestone(result.rows[0] as RawRow) };
}

export async function updateMilestone(
  userId: number,
  goalId: number,
  milestoneId: number,
  input: UpdateMilestoneInput,
): Promise<MilestoneMutationResult> {
  if (!(await goalExists(userId, goalId))) return { status: 'goal_not_found' };
  const existing = await query('SELECT * FROM milestones WHERE id = $1 AND goal_id = $2', [
    milestoneId,
    goalId,
  ]);
  const row = existing.rows[0] as RawRow | undefined;
  if (!row) return { status: 'milestone_not_found' };
  if (input.eventId != null && !(await findOwnedEvent(userId, input.eventId))) {
    return { status: 'event_not_found' };
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;
  if (input.title !== undefined) {
    updates.push(`title = $${paramIndex++}`);
    values.push(input.title);
  }
  if (input.dueAt !== undefined) {
    updates.push(`due_at = $${paramIndex++}`);
    values.push(input.dueAt ?? null);
  }
  if (input.sortOrder !== undefined) {
    updates.push(`sort_order = $${paramIndex++}`);
    values.push(input.sortOrder);
  }
  if (input.eventId !== undefined) {
    updates.push(`event_id = $${paramIndex++}`);
    values.push(input.eventId ?? null);
  }
  if (input.done !== undefined) {
    updates.push(`done_at = $${paramIndex++}`);
    // true 幂等保留首次完成时间；false 清空
    values.push(input.done ? (toIsoOrNull(row.done_at) ?? new Date().toISOString()) : null);
  }

  if (updates.length === 0) return { status: 'ok', milestone: serializeMilestone(row) };

  const result = await query(
    `UPDATE milestones SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND goal_id = $${paramIndex} RETURNING *`,
    [...values, milestoneId, goalId],
  );
  const updated = result.rows[0] as RawRow | undefined;
  if (!updated) return { status: 'milestone_not_found' };
  return { status: 'ok', milestone: serializeMilestone(updated) };
}

/**
 * 勾选 / 取消勾选里程碑。`done` 缺省 = 翻转；显式 true 幂等（保留首次 done_at）。
 * 完成全部里程碑不会自动关闭目标 —— 本函数不写 goals 表。
 */
export async function toggleMilestone(
  userId: number,
  goalId: number,
  milestoneId: number,
  done?: boolean,
): Promise<MilestoneMutationResult> {
  if (!(await goalExists(userId, goalId))) return { status: 'goal_not_found' };
  const existing = await query('SELECT * FROM milestones WHERE id = $1 AND goal_id = $2', [
    milestoneId,
    goalId,
  ]);
  const row = existing.rows[0] as RawRow | undefined;
  if (!row) return { status: 'milestone_not_found' };

  const wasDone = toIsoOrNull(row.done_at) != null;
  const nextDone = done === undefined ? !wasDone : done;
  const doneAt = nextDone ? (wasDone ? toIsoOrNull(row.done_at) : new Date().toISOString()) : null;

  const result = await query(
    'UPDATE milestones SET done_at = $1 WHERE id = $2 AND goal_id = $3 RETURNING *',
    [doneAt, milestoneId, goalId],
  );
  const updated = result.rows[0] as RawRow | undefined;
  if (!updated) return { status: 'milestone_not_found' };
  return { status: 'ok', milestone: serializeMilestone(updated) };
}

export type DeleteMilestoneResult = 'deleted' | 'goal_not_found' | 'milestone_not_found';

export async function deleteMilestone(
  userId: number,
  goalId: number,
  milestoneId: number,
): Promise<DeleteMilestoneResult> {
  if (!(await goalExists(userId, goalId))) return 'goal_not_found';
  const result = await query('DELETE FROM milestones WHERE id = $1 AND goal_id = $2 RETURNING id', [
    milestoneId,
    goalId,
  ]);
  return result.rows.length > 0 ? 'deleted' : 'milestone_not_found';
}
