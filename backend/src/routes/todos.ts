import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  listTodoCompletions,
  markTodoComplete,
  unmarkTodoComplete,
  todoOccurrenceDate,
} from '../services/todo.service.js';
import { query } from '../db/index.js';
import { parseProfileFilter } from './profile-filter.js';

const todos = new Hono<{ Variables: { user: User } }>();
todos.use('*', authMiddleware);

const completeSchema = z.object({
  eventId: z.number().int().positive(),
  occurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

todos.get('/completions', async (c) => {
  const userId = Number(c.get('user').id);
  // 可选档案过滤（checkbox 69）：完成记录跟随其事件的档案；省略 = 全部档案。
  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;
  const rows = await listTodoCompletions(userId, profileFilter);
  return c.json({
    success: true,
    data: rows.map((r) => ({
      eventId: r.event_id,
      occurrenceDate: todoOccurrenceDate(r.occurrence_date),
      completedAt: r.completed_at,
    })),
  });
});

// v2.27：近 30 天待办完成率（完成的 occurrence 数 / 30 天内应完成的 occurrence 数）。
// 一条静态聚合 SQL：event 属主校验 + 用户时区无关的 occurrence_date（DATE 列）口径。
todos.get('/stats', async (c) => {
  const userId = Number(c.get('user').id);
  const { query } = await import('../db/index.js');
  const result = await query(
    `WITH due AS (
       SELECT e.id AS event_id, d::date AS occurrence_date
       FROM events e
       CROSS JOIN LATERAL generate_series(
         CURRENT_DATE - 29, CURRENT_DATE, INTERVAL '1 day'
       ) AS d
       WHERE e.user_id = $1
         AND e.date::date <= d::date
         -- 口径：一次性事件只在其日期当天应完成；daily 循环事件每天应完成；
         -- 其他循环频率近似只按事件日期计（略低估，不虚高分母）。
         AND (
           d::date = e.date::date
           OR ((e.recurring_config ->> 'enabled')::boolean IS TRUE
               AND e.recurring_config ->> 'frequency' = 'daily')
         )
     )
     SELECT
       (SELECT COUNT(*)::int FROM due) AS expected,
       (SELECT COUNT(*)::int FROM due
          JOIN todo_completions tc
            ON tc.event_id = due.event_id
           AND tc.occurrence_date = due.occurrence_date
         WHERE tc.user_id = $1) AS completed`,
    [userId],
  );
  const row = result.rows[0] as { expected?: number; completed?: number } | undefined;
  const expected = Number(row?.expected ?? 0);
  const completed = Number(row?.completed ?? 0);
  return c.json({
    success: true,
    data: {
      expected,
      completed,
      rate: expected > 0 ? Math.round((completed / expected) * 100) : null,
    },
  });
});

todos.post('/complete', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: '参数无效' }, 400);
  }

  const event = await query(
    'SELECT id, date FROM events WHERE id = $1 AND user_id = $2',
    [parsed.data.eventId, userId],
  );
  if (!event.rows.length) {
    return c.json({ success: false, error: '事件不存在' }, 404);
  }

  const row = event.rows[0] as { date: Date | string };
  const dateStr = parsed.data.occurrenceDate
    || (row.date instanceof Date
      ? row.date.toISOString().slice(0, 10)
      : String(row.date).slice(0, 10));

  await markTodoComplete(userId, parsed.data.eventId, dateStr);
  return c.json({ success: true, data: { eventId: parsed.data.eventId, occurrenceDate: dateStr } });
});

todos.delete('/complete', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: '参数无效' }, 400);
  }

  const event = await query(
    'SELECT date FROM events WHERE id = $1 AND user_id = $2',
    [parsed.data.eventId, userId],
  );
  if (!event.rows.length) {
    return c.json({ success: false, error: '事件不存在' }, 404);
  }

  const row = event.rows[0] as { date: Date | string };
  const dateStr = parsed.data.occurrenceDate
    || (row.date instanceof Date
      ? row.date.toISOString().slice(0, 10)
      : String(row.date).slice(0, 10));

  const ok = await unmarkTodoComplete(userId, parsed.data.eventId, dateStr);
  if (!ok) return c.json({ success: false, error: '记录不存在' }, 404);
  return c.json({ success: true });
});

export default todos;
