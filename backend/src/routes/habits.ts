import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  createHabitSchema,
  formatZodError,
  logHabitSchema,
  updateHabitSchema,
} from '@timemark/shared';
import {
  createHabit,
  deleteHabit,
  getHabitGrid,
  getHabitStreak,
  getHabitWithStreak,
  listHabits,
  logHabit,
  updateHabit,
} from '../services/habit.service.js';

/**
 * 习惯打卡 API（D6，checkbox 64/65）。
 *
 * 约定与 /api/expiry、/api/documents 一致：`new Hono<{Variables:{user:User}}>()` +
 * `use('*', authMiddleware)`；「不存在」与「他人的行」都是 404（防存在性泄露）。
 *
 * 路由顺序：/grid 必须注册在 /:id 之前。连胜由 shared/src/habit-schedule.ts 的
 * 纯函数计算（用户 IANA 时区；与服务器 TZ 无关），服务端只负责取数。
 */
const habits = new Hono<{ Variables: { user: User } }>();
habits.use('*', authMiddleware);

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

habits.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const activeRaw = c.req.query('active');
  let active: boolean | undefined;
  if (activeRaw === 'true') active = true;
  else if (activeRaw === 'false') active = false;
  else if (activeRaw !== undefined && activeRaw !== '') {
    return c.json({ success: false, error: "active 只能为 'true' 或 'false'" }, 400);
  }

  const data = await listHabits(userId, { active });
  return c.json({ success: true, data });
});

// 日历网格（7x-habit 周视图的数据源）；必须早于 /:id 注册
habits.get('/grid', async (c) => {
  const userId = Number(c.get('user').id);
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!YMD_RE.test(from) || !YMD_RE.test(to)) {
    return c.json({ success: false, error: 'from / to 必须为 YYYY-MM-DD' }, 400);
  }
  try {
    const data = await getHabitGrid(userId, from, to);
    return c.json({ success: true, data });
  } catch (error) {
    if (error instanceof RangeError) {
      return c.json({ success: false, error: error.message }, 400);
    }
    throw error;
  }
});

habits.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createHabitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }
  const data = await createHabit(userId, parsed.data);
  return c.json({ success: true, data }, 201);
});

habits.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const data = await getHabitWithStreak(userId, id);
  if (!data) return c.json({ success: false, error: '习惯不存在' }, 404);
  return c.json({ success: true, data });
});

habits.get('/:id/streak', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const data = await getHabitStreak(userId, id);
  if (!data) return c.json({ success: false, error: '习惯不存在' }, 404);
  return c.json({ success: true, data });
});

habits.post('/:id/log', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = logHabitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const result = await logHabit(userId, id, parsed.data);
  if (result.status === 'not_found') {
    return c.json({ success: false, error: '习惯不存在' }, 404);
  }
  if (result.status === 'future_date') {
    return c.json({ success: false, error: `不能为未来日期打卡（今天是 ${result.today}）` }, 400);
  }
  return c.json({ success: true, data: result.log });
});

habits.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateHabitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const data = await updateHabit(userId, id, parsed.data);
  if (!data) return c.json({ success: false, error: '习惯不存在' }, 404);
  return c.json({ success: true, data });
});

habits.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const deleted = await deleteHabit(userId, id);
  if (!deleted) return c.json({ success: false, error: '习惯不存在' }, 404);
  return c.json({ success: true });
});

export default habits;
