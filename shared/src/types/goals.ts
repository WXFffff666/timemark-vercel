/**
 * 目标与里程碑（个人目标清单，checkbox 81）— Zod 校验与类型
 *
 * 领域：个人目标（学习/健身/存钱/读书……）+ 可勾选的里程碑清单。
 * 明确不做 OKR 黑话、不做团队/协作功能。
 *
 * - `targetValue` 可为 null（纯里程碑目标），但绝不为 0：0 会让百分比失去意义。
 * - `currentValue` 存的是原始值（可以超过 targetValue，表示超额完成）；
 *   只有派生给前端的 `progress` 才 clamp 到 [0, 100]。
 * - `milestone.eventId` 可选钉在一个既有事件上，从而复用既有提醒引擎。
 */
import { z } from 'zod';

/** 目标状态；done 只能由显式动作设置，里程碑全部完成不会自动关闭目标 */
export const GOAL_STATUSES = ['active', 'paused', 'done', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const goalStatusSchema = z.enum(GOAL_STATUSES);

const ymdDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD');

const goalFieldsSchema = z.object({
  title: z.string().min(1, '标题不能为空').max(200),
  description: z.string().max(2000).nullish(),
  category: z.string().max(100).nullish(),
  /** 目标值：必须 > 0（0 无法计算百分比）；null/缺省 = 纯里程碑目标 */
  targetValue: z.number().positive('目标值必须大于 0').nullish(),
  /** 当前值（原始值）：>= 0，可超过目标值（进度展示时封顶） */
  currentValue: z.number().min(0, '当前值不能为负数').optional(),
  unit: z.string().max(50).nullish(),
  startDate: ymdDateSchema.optional(),
  targetDate: ymdDateSchema.nullish(),
  status: goalStatusSchema.optional(),
  /** 预留：D5 家庭档案 */
  profileId: z.number().int().positive().nullish(),
});

function targetDateNotBeforeStart(data: {
  startDate?: string | null;
  targetDate?: string | null;
}): boolean {
  if (!data.startDate || !data.targetDate) return true;
  return data.targetDate >= data.startDate;
}

const TARGET_BEFORE_START_MESSAGE = 'target_date 不能早于 start_date';

export const createGoalSchema = goalFieldsSchema.refine(targetDateNotBeforeStart, {
  message: TARGET_BEFORE_START_MESSAGE,
  path: ['targetDate'],
});

export const updateGoalSchema = goalFieldsSchema.partial().refine(targetDateNotBeforeStart, {
  message: TARGET_BEFORE_START_MESSAGE,
  path: ['targetDate'],
});

/** `POST /api/goals/:id/progress`：设置原始当前值（服务端只 clamp 展示百分比） */
export const setGoalProgressSchema = z.object({
  currentValue: z.number().min(0, '当前值不能为负数'),
});

const milestoneFieldsSchema = z.object({
  title: z.string().min(1, '标题不能为空').max(200),
  dueAt: ymdDateSchema.nullish(),
  /** 可选：钉在一个既有事件上，复用提醒引擎；null = 不关联 */
  eventId: z.number().int().positive().nullish(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});

export const createMilestoneSchema = milestoneFieldsSchema;
export const updateMilestoneSchema = milestoneFieldsSchema.partial().extend({
  /** true = 完成（幂等保留首次完成时间），false = 取消完成；缺省 = 不改动 */
  done: z.boolean().optional(),
});
export const toggleMilestoneSchema = z.object({
  /** 缺省 = 翻转当前状态 */
  done: z.boolean().optional(),
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type SetGoalProgressInput = z.infer<typeof setGoalProgressSchema>;
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;
export type ToggleMilestoneInput = z.infer<typeof toggleMilestoneSchema>;

export interface MilestoneRecord {
  id: number;
  goal_id: number;
  title: string;
  due_at: string | null;
  done_at: string | null;
  sort_order: number;
  /** 关联事件（可选）：该事件照常走既有提醒引擎 */
  event_id: number | null;
}

export interface GoalRecord {
  id: number;
  user_id: number;
  profile_id: number | null;
  title: string;
  description: string | null;
  category: string | null;
  target_value: number | null;
  /** 原始当前值（未经 clamp） */
  current_value: number;
  unit: string | null;
  start_date: string | null;
  target_date: string | null;
  status: GoalStatus;
  created_at: string | null;
  updated_at: string | null;
  /** 值进度：clamp 到 [0, 100]，保留 2 位小数；无目标值时为 null */
  progress: number | null;
  milestone_count: number;
  milestone_done_count: number;
}

export interface GoalWithMilestones extends GoalRecord {
  milestones: MilestoneRecord[];
}
