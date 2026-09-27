import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { formatZodError, logDoseSchema } from '@timemark/shared';
import { logDose, snoozeDose } from '../services/medication.service.js';

/**
 * 用药剂量记录 API（D3，checkbox 72）。
 *
 * - POST /:id/log：status taken|skipped → logged_at=now；taken 扣库存（幂等，不重复扣）。
 * - 未来剂量 400；他人 / 不存在的剂量 404。
 */
const doses = new Hono<{ Variables: { user: User } }>();
doses.use('*', authMiddleware);

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

doses.post('/:id/log', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = logDoseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const result = await logDose(userId, id, parsed.data);
  if (result.status === 'not_found') {
    return c.json({ success: false, error: '剂量不存在' }, 404);
  }
  if (result.status === 'future_dose') {
    return c.json({ success: false, error: `不能记录未来剂量（计划时间 ${result.scheduledFor}）` }, 400);
  }
  return c.json({ success: true, data: { dose: result.dose, stockQuantity: result.stockQuantity } });
});

/**
 * 稍后提醒（checkbox 73）：10 分钟后由提醒任务再发一条。
 * 已记录（taken/skipped/missed）的剂量不允许稍后提醒。
 */
doses.post('/:id/snooze', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const result = await snoozeDose(userId, id);
  if (result.status === 'not_found') {
    return c.json({ success: false, error: '剂量不存在' }, 404);
  }
  if (result.status === 'already_logged') {
    return c.json({ success: false, error: '该剂量已记录，无需稍后提醒' }, 409);
  }
  return c.json({ success: true, data: { doseId: result.doseId, snoozedUntil: result.snoozedUntil } });
});

export default doses;
