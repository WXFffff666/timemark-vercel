import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  GOAL_STATUSES,
  createGoalSchema,
  createMilestoneSchema,
  formatZodError,
  setGoalProgressSchema,
  toggleMilestoneSchema,
  updateGoalSchema,
  updateMilestoneSchema,
} from '@timemark/shared';
import {
  createGoal,
  createMilestone,
  deleteGoal,
  deleteMilestone,
  getGoal,
  listGoals,
  setGoalProgress,
  toggleMilestone,
  updateGoal,
  updateMilestone,
} from '../services/goals.service.js';
import { findOwnedProfile } from '../services/profile.service.js';
import { parseProfileFilter } from './profile-filter.js';

/**
 * 目标与里程碑 API（个人目标清单，checkbox 81）。
 *
 * 约定与 /api/expiry、/api/profiles 一致：`new Hono<{Variables:{user:User}}>()` +
 * `use('*', authMiddleware)`；「不存在」与「他人的行」都是 404（防存在性泄露）。
 * 全部查询按 user_id 限定；`?profileId=` 为可选档案过滤（checkbox 69）：省略 =
 * 全部档案，他人的 / 已归档的档案一律 404。
 *
 * - `POST /:id/progress` 写入原始 current_value（不 clamp；可超过目标值），响应里的
 *   `progress` 才 clamp 到 100%。
 * - 里程碑勾选 / 取消勾选不会自动关闭目标：done 状态只能由显式 PATCH 设置。
 * - 删除目标会级联删除其里程碑（数据库外键），但绝不触碰里程碑关联的事件。
 * - 不做 OKR 黑话、不做团队 / 协作功能。
 */
const goals = new Hono<{ Variables: { user: User } }>();
goals.use('*', authMiddleware);

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function zodError(parsed: { error: z.ZodError }) {
  return {
    success: false as const,
    error: formatZodError(parsed.error),
    details: z.flattenError(parsed.error),
  };
}

type GoalsContext = Context<{ Variables: { user: User } }>;

function milestoneError(
  c: GoalsContext,
  status: 'goal_not_found' | 'milestone_not_found' | 'event_not_found',
): Response {
  if (status === 'goal_not_found') return c.json({ success: false, error: '目标不存在' }, 404);
  if (status === 'milestone_not_found') return c.json({ success: false, error: '里程碑不存在' }, 404);
  return c.json({ success: false, error: '事件不存在' }, 404);
}

goals.get('/', async (c) => {
  const userId = Number(c.get('user').id);

  const statusRaw = c.req.query('status');
  if (statusRaw && !(GOAL_STATUSES as readonly string[]).includes(statusRaw)) {
    return c.json({ success: false, error: `未知的目标状态: ${statusRaw}` }, 400);
  }

  // 可选档案过滤（checkbox 69）：省略 = 全部档案；他人的档案一律 404。
  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;

  const data = await listGoals(userId, {
    status: statusRaw as (typeof GOAL_STATUSES)[number] | undefined,
    profileId: profileFilter,
  });
  return c.json({ success: true, data });
});

goals.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createGoalSchema.safeParse(body);
  if (!parsed.success) return c.json(zodError(parsed), 400);

  if (parsed.data.profileId != null && !(await findOwnedProfile(userId, parsed.data.profileId))) {
    return c.json({ success: false, error: '档案不存在' }, 404);
  }

  const data = await createGoal(userId, parsed.data);
  return c.json({ success: true, data }, 201);
});

goals.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const data = await getGoal(userId, id);
  if (!data) return c.json({ success: false, error: '目标不存在' }, 404);
  return c.json({ success: true, data });
});

// v2.27：里程碑独立子资源（此前只在 /:id 整体返回里出现）
goals.get('/:id/milestones', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);
  const { getGoal } = await import('../services/goals.service.js');
  const data = await getGoal(userId, id);
  if (!data) return c.json({ success: false, error: '目标不存在' }, 404);
  return c.json({ success: true, data: data.milestones });
});

goals.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateGoalSchema.safeParse(body);
  if (!parsed.success) return c.json(zodError(parsed), 400);

  const existing = await getGoal(userId, id);
  if (!existing) return c.json({ success: false, error: '目标不存在' }, 404);

  // 部分更新时跨字段校验（start_date 未随请求提供则取库中现值）
  const effectiveStart = parsed.data.startDate ?? existing.start_date;
  const effectiveTarget =
    parsed.data.targetDate !== undefined ? parsed.data.targetDate : existing.target_date;
  if (effectiveStart && effectiveTarget && effectiveTarget < effectiveStart) {
    return c.json({ success: false, error: 'target_date 不能早于 start_date' }, 400);
  }

  if (parsed.data.profileId != null && !(await findOwnedProfile(userId, parsed.data.profileId))) {
    return c.json({ success: false, error: '档案不存在' }, 404);
  }

  const data = await updateGoal(userId, id, parsed.data);
  if (!data) return c.json({ success: false, error: '目标不存在' }, 404);
  return c.json({ success: true, data });
});

goals.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const deleted = await deleteGoal(userId, id);
  if (!deleted) return c.json({ success: false, error: '目标不存在' }, 404);
  return c.json({ success: true });
});

goals.post('/:id/progress', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = setGoalProgressSchema.safeParse(body);
  if (!parsed.success) return c.json(zodError(parsed), 400);

  const data = await setGoalProgress(userId, id, parsed.data.currentValue);
  if (!data) return c.json({ success: false, error: '目标不存在' }, 404);
  return c.json({ success: true, data });
});

goals.post('/:id/milestones', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = createMilestoneSchema.safeParse(body);
  if (!parsed.success) return c.json(zodError(parsed), 400);

  const result = await createMilestone(userId, id, parsed.data);
  if (result.status !== 'ok') return milestoneError(c, result.status);
  return c.json({ success: true, data: result.milestone }, 201);
});

goals.patch('/:id/milestones/:milestoneId', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  const milestoneId = parseId(c.req.param('milestoneId'));
  if (id === null || milestoneId === null) {
    return c.json({ success: false, error: '无效的 ID' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateMilestoneSchema.safeParse(body);
  if (!parsed.success) return c.json(zodError(parsed), 400);

  const result = await updateMilestone(userId, id, milestoneId, parsed.data);
  if (result.status !== 'ok') return milestoneError(c, result.status);
  return c.json({ success: true, data: result.milestone });
});

goals.post('/:id/milestones/:milestoneId/toggle', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  const milestoneId = parseId(c.req.param('milestoneId'));
  if (id === null || milestoneId === null) {
    return c.json({ success: false, error: '无效的 ID' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = toggleMilestoneSchema.safeParse(body);
  if (!parsed.success) return c.json(zodError(parsed), 400);

  const result = await toggleMilestone(userId, id, milestoneId, parsed.data.done);
  if (result.status !== 'ok') return milestoneError(c, result.status);
  return c.json({ success: true, data: result.milestone });
});

goals.delete('/:id/milestones/:milestoneId', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  const milestoneId = parseId(c.req.param('milestoneId'));
  if (id === null || milestoneId === null) {
    return c.json({ success: false, error: '无效的 ID' }, 400);
  }

  const result = await deleteMilestone(userId, id, milestoneId);
  if (result === 'goal_not_found') return c.json({ success: false, error: '目标不存在' }, 404);
  if (result === 'milestone_not_found') return c.json({ success: false, error: '里程碑不存在' }, 404);
  return c.json({ success: true });
});

export default goals;
